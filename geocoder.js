/**
 * @fileoverview Local reverse geocoder based on GeoNames data.
 * @author Thomas Steiner (tomac@google.com)
 * @license Apache 2.0
 *
 * @param {(object|object[])} points One single or an array of
 *                                   latitude/longitude pairs
 * @param {integer} maxResults The maximum number of results to return
 * @callback callback The callback function with the results
 *
 * @returns {object[]} An array of GeoNames-based geocode results
 *
 * @example
 * // With just one point
 * var point = {latitude: 42.083333, longitude: 3.1};
 * geocoder.lookUp(point, 1, function(err, res) {
 *   console.log(JSON.stringify(res, null, 2));
 * });
 *
 * // In batch mode with many points
 * var points = [
 *   {latitude: 42.083333, longitude: 3.1},
 *   {latitude: 48.466667, longitude: 9.133333}
 * ];
 * geocoder.lookUp(points, 1, function(err, res) {
 *   console.log(JSON.stringify(res, null, 2));
 * });
 */

'use strict';

var debug = require('debug')('local-reverse-geocoder');
var fs = require('fs');
var path = require('path');
var parse = require('csv-parse');
var kdTree = require('kdt');
var request = require('request');
var unzip = require('node-unzip-2');
var async = require('async');
var readline = require('readline');

// All data from http://download.geonames.org/export/dump/
var GEONAMES_URL = 'http://download.geonames.org/export/dump/';

var CITIES_FILE = 'cities1000';
var ADMIN_1_CODES_FILE = 'admin1CodesASCII';
var ADMIN_2_CODES_FILE = 'admin2Codes';
var ALL_COUNTRIES_FILE = 'allCountries';
var ALTERNATE_NAMES_FILE = 'alternateNames';
var COUNTRY_INFO_FILE = 'countryInfo';

/* jshint maxlen: false */
var GEONAMES_COLUMNS = [
  'geoNameId', // integer id of record in geonames database
  'name', // name of geographical point (utf8) varchar(200)
  'asciiName', // name of geographical point in plain ascii characters, varchar(200)
  'alternateNames', // alternatenames, comma separated, ascii names automatically transliterated, convenience attribute from alternatename table, varchar(10000)
  'latitude', // latitude in decimal degrees (wgs84)
  'longitude', // longitude in decimal degrees (wgs84)
  'featureClass', // see http://www.geonames.org/export/codes.html, char(1)
  'featureCode', // see http://www.geonames.org/export/codes.html, varchar(10)
  'countryCode', // ISO-3166 2-letter country code, 2 characters
  'cc2', // alternate country codes, comma separated, ISO-3166 2-letter country code, 60 characters
  'admin1Code', // fipscode (subject to change to iso code), see exceptions below, see file admin1Codes.txt for display names of this code; varchar(20)
  'admin2Code', // code for the second administrative division, a county in the US, see file admin2Codes.txt; varchar(80)
  'admin3Code', // code for third level administrative division, varchar(20)
  'admin4Code', // code for fourth level administrative division, varchar(20)
  'population', // bigint (8 byte int)
  'elevation', // in meters, integer
  'dem', // digital elevation model, srtm3 or gtopo30, average elevation 3''x3'' (ca 90mx90m) or 30''x30'' (ca 900mx900m) area in meters, integer. srtm processed by cgiar/ciat.
  'timezone', // the timezone id (see file timeZone.txt) varchar(40)
  'modificationDate', // date of last modification in yyyy-MM-dd format
];
/* jshint maxlen: 120 */

var GEONAMES_ADMIN_CODES_COLUMNS = [
  'concatenatedCodes',
  'name',
  'asciiName',
  'geoNameId'
];

/* jshint maxlen: false */
var GEONAMES_ALTERNATE_NAMES_COLUMNS = [
  'alternateNameId', // the id of this alternate name, int
  'geoNameId', // geonameId referring to id in table 'geoname', int
  'isoLanguage', // iso 639 language code 2- or 3-characters; 4-characters 'post' for postal codes and 'iata','icao' and faac for airport codes, fr_1793 for French Revolution name
  'alternateNames', // alternate name or name variant, varchar(200)
  'isPreferrredName', // '1', if this alternate name is an official/preferred name
  'isShortName', // '1', if this is a short name like 'California' for 'State of California'
  'isColloquial', // '1', if this alternate name is a colloquial or slang term
  'isHistoric' // '1', if this alternate name is historic and was used in the past
];
/* jshint maxlen: 120 */

var GEONAMES_DUMP = __dirname + '/geonames_dump';

var geocoder = {

  _kdTree: null,

  _countryInfo: null,
  _admin1Codes: null,
  _admin2Codes: null,
  _admin3Codes: null,
  _admin4Codes: null,
  _alternateNames: null,

  // Distance function taken from
  // http://www.movable-type.co.uk/scripts/latlong.html
  _distanceFunc: function distance(x, y) {
    var toRadians = function(num) {
      return num * Math.PI / 180;
    };
    var lat1 = x.latitude;
    var lon1 = x.longitude;
    var lat2 = y.latitude;
    var lon2 = y.longitude;

    var R = 6371; // km
    var φ1 = toRadians(lat1);
    var φ2 = toRadians(lat2);
    var Δφ = toRadians(lat2 - lat1);
    var Δλ = toRadians(lon2 - lon1);
    var a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  _getGeoDataZipFile: function(callback, subdir, fileBaseName, displayName) {
    var now = (new Date()).toISOString().substr(0, 10);
    // Use timestamped file OR bare file
    var timestampedFilename = GEONAMES_DUMP + '/' + subdir + '/' +
        fileBaseName + '_' + now + '.txt';
    if (fs.existsSync(timestampedFilename)) {
      debug('Using cached GeoNames ' + displayName + ' data from ' +
          timestampedFilename);
      return callback(null, timestampedFilename);
    }

    var filename = GEONAMES_DUMP + '/' + subdir + '/' + fileBaseName + '.txt';
    if (fs.existsSync(filename)) {
      debug('Using cached GeoNames ' + displayName + ' data from ' +
          filename);
      return callback(null, filename);
    }

    debug('Getting GeoNames ' + displayName  + ' data from ' +
        GEONAMES_URL + fileBaseName + '.zip (this may take a while)');
    var options = {
      proxy: process.env.PROXY,
      url: GEONAMES_URL + fileBaseName + '.zip',
      encoding: null
    };
    request.get(options, function(err, response, body) {
      if (err || response.statusCode !== 200) {
        return callback('Error downloading GeoNames ' + displayName + ' data' +
            (err ? ': ' + err : ''));
      }
      debug('Received zipped GeoNames ' + displayName + ' data');
      // Store a dump locally
      if (!fs.existsSync(GEONAMES_DUMP + '/' + subdir)) {
        fs.mkdirSync(GEONAMES_DUMP + '/' + subdir);
      }
      var zipFilename = GEONAMES_DUMP + '/' + subdir + '/' +
          fileBaseName + '_' + now + '.zip';
      try {
        fs.writeFileSync(zipFilename, body);
        fs.createReadStream(zipFilename)
            .pipe(unzip.Extract({path: GEONAMES_DUMP + '/' + subdir}))
            .on('error', function(e) {
              console.error(e);
            })
            .on('close', function() {
              fs.renameSync(filename, timestampedFilename);
              fs.unlinkSync(zipFilename);
              debug('Unzipped GeoNames ' + displayName + ' data');
              // Housekeeping, remove old files
              var currentFileName = path.basename(timestampedFilename);
              fs.readdirSync(GEONAMES_DUMP + '/' + subdir).forEach(
                  function(file) {
                if (file !== currentFileName) {
                  fs.unlinkSync(GEONAMES_DUMP + '/' + subdir + '/' + file);
                }
              });
              return callback(null, timestampedFilename);
            });
      } catch (e) {
        debug('Warning: ' + e);
        return callback(null, timestampedFilename);
      }
    });
  },

  _getGeoDataTextFile: function(callback, subdir, fileBaseName, displayName) {
    var now = (new Date()).toISOString().substr(0, 10);
    // Use timestamped file OR bare file
    var timestampedFilename = GEONAMES_DUMP + '/' + subdir + '/' +
        fileBaseName + '_' + now + '.txt';
    if (fs.existsSync(timestampedFilename)) {
      debug('Using cached GeoNames ' + displayName + ' data from ' +
          timestampedFilename);
      return callback(null, timestampedFilename);
    }

    var filename = GEONAMES_DUMP + '/' + subdir + '/' + fileBaseName + '.txt';
    if (fs.existsSync(filename)) {
      debug('Using cached GeoNames ' + displayName + ' data from ' +
          filename);
      return callback(null, filename);
    }

    debug('Getting GeoNames ' + displayName  + ' data from ' +
        GEONAMES_URL + fileBaseName + '.txt (this may take a while)');
    var options = {
    proxy: process.env.PROXY,
      url: GEONAMES_URL + fileBaseName + '.txt',
      encoding: null
    };
    request.get(options, function(err, response, body) {
      if (err || response.statusCode !== 200) {
        return callback('Error downloading GeoNames ' + displayName + ' data' +
            (err ? ': ' + err : ''));
      }
      debug('Received GeoNames ' + displayName + ' data');
      // Store a dump locally
      if (!fs.existsSync(GEONAMES_DUMP + '/' + subdir)) {
        fs.mkdirSync(GEONAMES_DUMP + '/' + subdir);
      }

      try {
        fs.writeFileSync(timestampedFilename, body);
        // Housekeeping, remove old files
        var currentFileName = path.basename(timestampedFilename);
        fs.readdirSync(GEONAMES_DUMP + '/' + subdir).forEach(
          function(file) {
          if (file !== currentFileName) {
            fs.unlinkSync(GEONAMES_DUMP + '/' + subdir + '/' + file);
          }
        });
      } catch (e) {
        throw (e);
      }
      return callback(null, timestampedFilename);
    });
  },

  _getGeoNamesAlternateNamesData: function(callback) {
    return this._getGeoDataZipFile(callback, 'alternate_names', ALTERNATE_NAMES_FILE, 'alternate names');
  },

  _parseGeoNamesAlternateNamesCsv: function(pathToCsv, callback) {
    var that = this;
    that._alternateNames = {};
    var lineReader = readline.createInterface({
      input: fs.createReadStream(pathToCsv)
    });
    lineReader.on('line', function(line) {
      line = line.split('\t');

      const [
        _,
        geoNameId,
        isoLanguage,
        altName,
        isPreferredName,
        isShortName,
        isColloquial,
        isHistoric
      ] = line;

      // Require valid language
      if (!!isoLanguage && isoLanguage !== '' && isoLanguage !== 'link') {
        if (!that._alternateNames[geoNameId]) {
          that._alternateNames[geoNameId] = {};
        }
        if (! that._alternateNames[geoNameId][isoLanguage] || isPreferredName == '1') {
          // the following construct seems weird, but saves lots of heap
          // space (hundreds of megabytes) because the sliced strings are released.
          that._alternateNames[geoNameId][isoLanguage] = JSON.parse(JSON.stringify(altName));
        }
      }
    }).on('close', function() {
      return callback();
    });
  },

  _getGeoNamesCountryInfoData: function(callback) {
    return this._getGeoDataTextFile(callback, 'country_info', COUNTRY_INFO_FILE, 'country');
  },

  _parseGeoNamesCountryInfoCsv: function(pathToCsv, callback) {
    var that = this;
    that._countryInfo = {};
    var lineReader = readline.createInterface({
      input: fs.createReadStream(pathToCsv)
    });

    lineReader.on('line', function (line) {
      line = line.split('\t');
      if (line[0] > '' && line[16] && line[16] !== '') {
        that._countryInfo[line[0]] = {};
        that._countryInfo[line[0]].geoId = line[16];
        if (that._alternateNames[line[16]]) {
          that._countryInfo[line[0]].alternateNames=that._alternateNames[line[16]];
        }
      }
    }).on('close', function() {
      return callback();
    });
  },

  _getGeoNamesAdmin1CodesData: function(callback) {
    return this._getGeoDataTextFile(callback, 'admin1_codes', ADMIN_1_CODES_FILE, 'admin 1 codes');
  },

  _parseGeoNamesAdmin1CodesCsv: function(pathToCsv, callback) {
    var that = this;
    var lenI = GEONAMES_ADMIN_CODES_COLUMNS.length;
    that._admin1Codes = {};
    var lineReader = readline.createInterface({
      input: fs.createReadStream(pathToCsv)
    });
    lineReader.on('line', function(line) {
      line = line.split('\t');
      for (var i = 0; i < lenI; i++) {
        var value = line[i] || null;
        if (i === 0) {
          that._admin1Codes[value] = {};
        } else {
          that._admin1Codes[line[0]][GEONAMES_ADMIN_CODES_COLUMNS[i]] = value;
        }
      }
      if (that._alternateNames[line[3]]) {
        that._admin1Codes[line[0]].alternateNames=that._alternateNames[line[3]];
      }
    }).on('close', function() {
      return callback();
    });
  },

  _getGeoNamesAdmin2CodesData: function(callback) {
    return this._getGeoDataTextFile(callback, 'admin2_codes', ADMIN_2_CODES_FILE, 'admin 2 codes');
  },

  _parseGeoNamesAdmin2CodesCsv: function(pathToCsv, callback) {
    var that = this;
    var lenI = GEONAMES_ADMIN_CODES_COLUMNS.length;
    that._admin2Codes = {};
    var lineReader = readline.createInterface({
      input: fs.createReadStream(pathToCsv)
    });
    lineReader.on('line', function(line) {
      line = line.split('\t');
      for (var i = 0; i < lenI; i++) {
        var value = line[i] || null;
        if (i === 0) {
          that._admin2Codes[value] = {};
        } else {
          that._admin2Codes[line[0]][GEONAMES_ADMIN_CODES_COLUMNS[i]] = JSON.parse(JSON.stringify(value));
        }
      }
      if (that._alternateNames[line[3]]) {
        that._admin2Codes[line[0]].alternateNames=that._alternateNames[line[3]];
      }
    }).on('close', function() {
      return callback();
    });
  },

  _getGeoNamesCitiesData: function(callback) {
    return this._getGeoDataZipFile(callback, 'cities', CITIES_FILE, 'cities');
  },

  _parseGeoNamesCitiesCsv: function(pathToCsv, callback) {
    debug('Started parsing cities.txt (this may take a ' +
        'while)');
    var data = [];
    var lenI = GEONAMES_COLUMNS.length;
    var that = this;
    var latitudeIndex = GEONAMES_COLUMNS.indexOf('latitude');
    var longitudeIndex = GEONAMES_COLUMNS.indexOf('longitude');

    var lineReader = require('readline').createInterface({
      input: require('fs').createReadStream(pathToCsv)
    });

    lineReader.on('line', function (line) {
      var lineObj = {};
      line = JSON.parse(JSON.stringify(line)).split('\t');

      for (var i = 0; i < lenI; i++) {
        var column = line[i] || null;
        lineObj[GEONAMES_COLUMNS[i]] = column;
      }

      var lng = lineObj[GEONAMES_COLUMNS[latitudeIndex]];
      var lat = lineObj[GEONAMES_COLUMNS[longitudeIndex]];
      //dont add locations without lat/lng pair
      if (lng !== null && lng !== undefined && !isNaN(lng) &&
          lat !== null && lat !== undefined && !isNaN(lat)) {
        if (that._alternateNames[lineObj.geoNameId]) {
          var alt = that._alternateNames[lineObj.geoNameId] || null;
          for (var x in alt) {
            if (alt[x]==lineObj.name)
              delete alt[x];
          }
          lineObj.alternateNames=alt;
        }
        data.push(lineObj);
      }
    }).on('close', function() {
      debug('Finished parsing cities.txt');
      debug('Started building cities k-d tree (this may take ' +
        'a while)');

      var dimensions = [
        'latitude',
        'longitude'
      ];
      that._kdTree = kdTree.createKdTree(data, that._distanceFunc, dimensions);
      debug('Finished building cities k-d tree');
      return callback();
    });
  },

  _getGeoNamesAllCountriesData: function(callback) {
    return this._getGeoDataZipFile(callback, 'all_countries', ALL_COUNTRIES_FILE, 'all countries');
  },

  _parseGeoNamesAllCountriesCsv: function(pathToCsv, callback) {
    debug('Started parsing all countries.txt (this  may take ' +
        'a while)');
    var that = this;
    // Indexes
    var featureCodeIndex = GEONAMES_COLUMNS.indexOf('featureCode');
    var countryCodeIndex = GEONAMES_COLUMNS.indexOf('countryCode');
    var admin1CodeIndex = GEONAMES_COLUMNS.indexOf('admin1Code');
    var admin2CodeIndex = GEONAMES_COLUMNS.indexOf('admin2Code');
    var admin3CodeIndex = GEONAMES_COLUMNS.indexOf('admin3Code');
    var admin4CodeIndex = GEONAMES_COLUMNS.indexOf('admin4Code');
    var nameIndex = GEONAMES_COLUMNS.indexOf('name');
    var asciiNameIndex = GEONAMES_COLUMNS.indexOf('asciiName');
    var geoNameIdIndex = GEONAMES_COLUMNS.indexOf('geoNameId');

    var counter = 0;
    that._admin3Codes = {};
    that._admin4Codes = {};
    var lineReader = readline.createInterface({
      input: fs.createReadStream(pathToCsv)
    });
    lineReader.on('line', function(line) {
      line = line.split('\t');
      var featureCode = line[featureCodeIndex];
      if ((featureCode === 'ADM3') || (featureCode === 'ADM4')) {
        var lineObj = {
          name: line[nameIndex],
          asciiName: line[asciiNameIndex],
          geoNameId: line[geoNameIdIndex]
        };
        var key = line[countryCodeIndex] + '.' + line[admin1CodeIndex] + '.' +
            line[admin2CodeIndex] + '.' + line[admin3CodeIndex];
        if (featureCode === 'ADM3') {
          that._admin3Codes[key] = lineObj;
        } else if (featureCode === 'ADM4') {
          that._admin4Codes[key + '.' + line[admin4CodeIndex]] = lineObj;
        }
      }
      if (counter % 100000 === 0) {
        debug('Parsing progress all countries ' + counter);
      }
      counter++;
    }).on('close', function() {
      debug('Finished parsing all countries.txt');
      return callback();
    });
  },

  init: function(options, callback) {
    options = options || {};
    if (options.dumpDirectory) {
      GEONAMES_DUMP = options.dumpDirectory;
    }

    options.load = options.load || {};
    if (options.load.admin1 === undefined) {
      options.load.admin1 = true;
    }

    if (options.load.admin2 === undefined) {
      options.load.admin2 = true;
    }

    if (options.load.admin3And4 === undefined) {
      options.load.admin3And4 = false;
    }

    if (options.load.alternateNames === undefined) {
      options.load.alternateNames = true;
    }

    debug('Initializing local reverse geocoder using dump ' +
        'directory: ' + GEONAMES_DUMP);
    // Create local cache folder
    if (!fs.existsSync(GEONAMES_DUMP)) {
      fs.mkdirSync(GEONAMES_DUMP);
    }
    var that = this;

    // have to use series here to ensure alternate names are available
    // when parsing the actual cities/admin areas
    async.series([
      // Get GeoNames cities
      function(waterfallCallback) {
        async.waterfall([
          that._getGeoNamesAlternateNamesData.bind(that),
          that._parseGeoNamesAlternateNamesCsv.bind(that),

          that._getGeoNamesCitiesData.bind(that),
          that._parseGeoNamesCitiesCsv.bind(that)
      ], function() {
          return waterfallCallback();
        });
      },
      // Get GeoNames countries
      function(waterfallCallback) {
        async.waterfall([
          that._getGeoNamesCountryInfoData.bind(that),
          that._parseGeoNamesCountryInfoCsv.bind(that)
      ], function() {
          return waterfallCallback();
        });
      },
      // Get GeoNames admin 1 codes
      function(waterfallCallback) {
        if (options.load.admin1) {
          async.waterfall([
            that._getGeoNamesAdmin1CodesData.bind(that),
            that._parseGeoNamesAdmin1CodesCsv.bind(that)
          ], function() {
            return waterfallCallback();
          });
        } else {
          return setImmediate(waterfallCallback);
        }
      },
      // Get GeoNames admin 2 codes
      function(waterfallCallback) {
        if (options.load.admin2) {
          async.waterfall([
            that._getGeoNamesAdmin2CodesData.bind(that),
            that._parseGeoNamesAdmin2CodesCsv.bind(that)
          ], function() {
            return waterfallCallback();
          });
        } else {
          return setImmediate(waterfallCallback);
        }
      },
      // Get GeoNames all countries
      function(waterfallCallback) {
        if (options.load.admin3And4) {
          async.waterfall([
            that._getGeoNamesAllCountriesData.bind(that),
            that._parseGeoNamesAllCountriesCsv.bind(that)
          ], function() {
            return waterfallCallback();
          });
        } else {
          return setImmediate(waterfallCallback);
        }
    }
    ],
    // Main callback
    function(err) {
      that._alternateNames = null;

      if (err) {
        throw(err);
      }
      return callback();
    });
  },

  lookUp: function(points, arg2, arg3) {
    var callback;
    var maxResults;
    if (arguments.length === 2) {
      maxResults = 1;
      callback = arg2;
    } else {
      maxResults = arg2;
      callback = arg3;
    }
    this._lookUp(points, maxResults, function(err, results) {
      return callback(err, results);
    });
  },

  _lookUp: function(points, maxResults, callback) {
    var that = this;
    // If not yet initialied, then bail out
    if (!this._kdTree) {
      return (callback ('{}', null));
    // TODO: make non-preload work again while avoiding init retries on every call
    //       in case of failing init
    /*return this.init({}, function() {
        return that.lookUp(points, maxResults, callback);
      }); */
    }
    // Make sure we have an array of points
    if (!Array.isArray(points)) {
      points = [points];
    }
    var functions = [];
    points.forEach(function(point, i) {
      point = {
        latitude: parseFloat(point.latitude),
        longitude: parseFloat(point.longitude)
      };
      debug('Look-up request for point ' +
          JSON.stringify(point));
      functions[i] = function(innerCallback) {
        var result = that._kdTree.nearest(point, maxResults+3);
        // get a few more results above, then select the best ones weighted by distance and population
        // (add pop. 100 to accomodate tiny places or unknown population count)
        result.sort(function (a, b) {
          return (100+Number(b[0].population))*a[1]*a[1] - (100+Number(a[0].population))*b[1]*b[1];
        });
        result = result.slice (0, maxResults);

        for (var j = 0, lenJ = result.length; j < lenJ; j++) {
          if (result && result[j] && result[j][0]) {
            var countryCode = result[j][0].countryCode || '';
            //  var geoNameId = result[j][0].geoNameId || '';
            var admin1Code;
            var admin2Code;
            var admin3Code;
            var admin4Code;
            // Look-up of admin 1 code
            if (that._admin1Codes) {
              admin1Code = result[j][0].admin1Code || '';
              var admin1CodeKey = countryCode + '.' + admin1Code;
              result[j][0].admin1Code = that._admin1Codes[admin1CodeKey] ||
              result[j][0].admin1Code;
            }
            // Look-up of admin 2 code
            if (that._admin2Codes) {
              admin2Code = result[j][0].admin2Code || '';
              var admin2CodeKey = countryCode + '.' + admin1Code + '.' +
                  admin2Code;
              result[j][0].admin2Code = that._admin2Codes[admin2CodeKey] ||
                  result[j][0].admin2Code;
            }
            // Look-up of admin 3 code
            if (that._admin3Codes) {
              admin3Code = result[j][0].admin3Code || '';
              var admin3CodeKey = countryCode + '.' + admin1Code + '.' +
                  admin2Code + '.' + admin3Code;
              result[j][0].admin3Code = that._admin3Codes[admin3CodeKey] ||
                  result[j][0].admin3Code;
            }
            // Look-up of admin 4 code
            if (that._admin4Codes) {
              admin4Code = result[j][0].admin4Code || '';
              var admin4CodeKey = countryCode + '.' + admin1Code + '.' +
                  admin2Code + '.' + admin3Code + '.' + admin4Code;
              result[j][0].admin4Code = that._admin4Codes[admin4CodeKey] ||
                  result[j][0].admin4Code;
            }
            // Look-up of country alternate names
            if (that._countryInfo[countryCode])
                result[j][0].countryAltNames=that._countryInfo[countryCode].alternateNames;

            // Pull in the k-d tree distance in the main object
            result[j][0].distance = result[j][1];
            // Simplify the output by not returning an array
            result[j] = result[j][0];
          }
        }
/*      debug('Found result(s) for point ' +
            JSON.stringify(point) + result.map(function(subResult, i) {
              return '\n  (' + (++i) + ') {"geoNameId":"' +
                  subResult.geoNameId + '",' + '"name":"' + subResult.name +
                  '"}';
            }));
*/
        return innerCallback(null, result);
      };
    });
    async.series(
      functions,
    function(err, results) {
      debug('Delivering joint results');
      return callback(null, results);
    });
  }
};

module.exports = geocoder;
