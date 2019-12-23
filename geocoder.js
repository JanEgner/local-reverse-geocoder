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

const debug = require('debug')('local-reverse-geocoder');
const fs = require('fs');
const path = require('path');
const kdTree = require('kdt');
const request = require('request');
const unzip = require('node-unzip-2');
const async = require('async');
const readline = require('readline');

// All data from http://download.geonames.org/export/dump/
const GEONAMES_URL = 'http://download.geonames.org/export/dump/';

const ADMIN_1_CODES_FILE = 'admin1CodesASCII',
  ADMIN_2_CODES_FILE = 'admin2Codes',
  ALL_COUNTRIES_FILE = 'allCountries',
  ALTERNATE_NAMES_FILE = 'alternateNames',
  CITIES_FILE = 'cities1000',
  COUNTRY_INFO_FILE = 'countryInfo',

  /* jshint maxlen: false */
  GEONAMES_COLUMNS = [
    'geoNameId', // Integer id of record in geonames database
    'name', // Name of geographical point (utf8) varchar(200)
    'asciiName', // Name of geographical point in plain ascii characters, varchar(200)
    'alternateNames', // Alternatenames, comma separated, ascii names automatically transliterated, convenience attribute from alternatename table, varchar(10000)
    'latitude', // Latitude in decimal degrees (wgs84)
    'longitude', // Longitude in decimal degrees (wgs84)
    'featureClass', // See http://www.geonames.org/export/codes.html, char(1)
    'featureCode', // See http://www.geonames.org/export/codes.html, varchar(10)
    'countryCode', // ISO-3166 2-letter country code, 2 characters
    'cc2', // Alternate country codes, comma separated, ISO-3166 2-letter country code, 60 characters
    'admin1Code', // Fipscode (subject to change to iso code), see exceptions below, see file admin1Codes.txt for display names of this code; varchar(20)
    'admin2Code', // Code for the second administrative division, a county in the US, see file admin2Codes.txt; varchar(80)
    'admin3Code', // Code for third level administrative division, varchar(20)
    'admin4Code', // Code for fourth level administrative division, varchar(20)
    'population', // Bigint (8 byte int)
    'elevation', // In meters, integer
    'dem', // Digital elevation model, srtm3 or gtopo30, average elevation 3''x3'' (ca 90mx90m) or 30''x30'' (ca 900mx900m) area in meters, integer. srtm processed by cgiar/ciat.
    'timezone', // The timezone id (see file timeZone.txt) varchar(40)
    'modificationDate' // Date of last modification in yyyy-MM-dd format
  ],
  /* jshint maxlen: 120 */

  GEONAMES_ADMIN_CODES_COLUMNS = [
    'concatenatedCodes',
    'name',
    'asciiName',
    'geoNameId'
  ];

  /* jshint maxlen: false */
  /*
   * For documentation purposes only
   * var GEONAMES_ALTERNATE_NAMES_COLUMNS = [
   * 'alternateNameId', // the id of this alternate name, int
   * 'geoNameId', // geonameId referring to id in table 'geoname', int
   * 'isoLanguage', // iso 639 language code 2- or 3-characters; 4-characters 'post' for postal codes and 'iata','icao' and faac for airport codes, fr_1793 for French Revolution name
   * 'alternateNames', // alternate name or name variant, varchar(200)
   * 'isPreferrredName', // '1', if this alternate name is an official/preferred name
   * 'isShortName', // '1', if this is a short name like 'California' for 'State of California'
   * 'isColloquial', // '1', if this alternate name is a colloquial or slang term
   * 'isHistoric' // '1', if this alternate name is historic and was used in the past
   * ];
   */
  /* jshint maxlen: 120 */

let GEONAMES_DUMP = `${__dirname}/geonames_dump`;

const geocoder = {
  "_admin1Codes": null,
  "_admin2Codes": null,
  "_admin3Codes": null,
  "_admin4Codes": null,
  "_alternateNames": null,
  "_countryInfo": null,
  "_kdTree": null,

  /*
   * Distance function taken from
   * http://www.movable-type.co.uk/scripts/latlong.html
   */
  "_distanceFunc": function _distanceFunc (x, y) {
    const toRadians = function (num) {
        return num * Math.PI / 180;
      },
      lat1 = x.latitude,
      lon1 = x.longitude,
      lat2 = y.latitude,
      lon2 = y.longitude,

      R = 6371, // km
      φ1 = toRadians(lat1),
      φ2 = toRadians(lat2),
      Δφ = toRadians(lat2 - lat1),
      Δλ = toRadians(lon2 - lon1),
      a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ / 2) * Math.sin(Δλ / 2),
      c = 2 * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
      );
    return R * c;
  },

  "_getGeoDataZipFile" (callback, subdir, fileBaseName, displayName) {
    const now = new Date().toISOString().substr(0, 10),
      // Use timestamped file OR bare file
      timestampedFilename = `${GEONAMES_DUMP}/${subdir}/${
        fileBaseName}_${now}.txt`;
    if (fs.existsSync(timestampedFilename)) {
      debug(`Using cached GeoNames ${displayName} data from ${
        timestampedFilename}`);
      return callback(null, timestampedFilename);
    }

    const filename = `${GEONAMES_DUMP}/${subdir}/${fileBaseName}.txt`;
    if (fs.existsSync(filename)) {
      debug(`Using cached GeoNames ${displayName} data from ${
        filename}`);
      return callback(null, filename);
    }

    debug(`Getting GeoNames ${displayName} data from ${
      GEONAMES_URL}${fileBaseName}.zip (this may take a while)`);
    const options = {
      "encoding": null,
      "proxy": process.env.PROXY,
      "url": `${GEONAMES_URL + fileBaseName}.zip`
    };
    request.get(
      options,
      (err, response, body) => {
        if (err || response.statusCode !== 200) {
          return callback(`Error downloading GeoNames ${displayName} ${err}`);
        }
        debug(`Received zipped GeoNames ${displayName} data`);
        // Store a dump locally
        if (!fs.existsSync(`${GEONAMES_DUMP}/${subdir}`)) {
          fs.mkdirSync(`${GEONAMES_DUMP}/${subdir}`);
        }
        const zipFilename = `${GEONAMES_DUMP}/${subdir}/${fileBaseName}_${now}.zip`;
        try {
          fs.writeFileSync(zipFilename, body);
          fs.createReadStream(zipFilename).
            pipe(unzip.Extract({"path": `${GEONAMES_DUMP}/${subdir}`})).
            on('error',
              (e) => {
                console.error(e);
              }
            ).
            on('close',
              () => {
                fs.renameSync(filename, timestampedFilename);
                fs.unlinkSync(zipFilename);
                debug(`Unzipped GeoNames ${displayName} data`);
                // Housekeeping, remove old files
                const currentFileName = path.basename(timestampedFilename);
                fs.readdirSync(`${GEONAMES_DUMP}/${subdir}`).forEach((file) => {
                  if (file !== currentFileName) {
                    fs.unlinkSync(`${GEONAMES_DUMP}/${subdir}/${file}`);
                  }
                });
                return callback(null, timestampedFilename);
              }
            );
        } catch (e) {
          debug(`Warning: ${e}`);
          return callback(null, timestampedFilename);
        }
      }
    );
  },

  "_getGeoDataTextFile" (callback, subdir, fileBaseName, displayName) {
    const now = new Date().toISOString().substr(0, 10),
      // Use timestamped file OR bare file
      timestampedFilename = `${GEONAMES_DUMP}/${subdir}/${fileBaseName}_${now}.txt`;
    if (fs.existsSync(timestampedFilename)) {
      debug(`Using cached GeoNames ${displayName} data from ${timestampedFilename}`);
      return callback(null, timestampedFilename);
    }

    const filename = `${GEONAMES_DUMP}/${subdir}/${fileBaseName}.txt`;
    if (fs.existsSync(filename)) {
      debug(`Using cached GeoNames ${displayName} data from ${filename}`);
      return callback(null, filename);
    }

    debug(`Getting GeoNames ${displayName} data from ${
      GEONAMES_URL}${fileBaseName}.txt (this may take a while)`);
    const options = {
      "proxy": process.env.PROXY,
      "url": `${GEONAMES_URL + fileBaseName}.txt`,
      "encoding": null
    };
    request.get(
      options,
      (err, response, body) => {
        if (err || response.statusCode !== 200) {
          return callback(`Error downloading GeoNames ${displayName} data${
            err ? `: ${err}` : ''}`);
        }
        debug(`Received GeoNames ${displayName} data`);
        // Store a dump locally
        if (!fs.existsSync(`${GEONAMES_DUMP}/${subdir}`)) {
          fs.mkdirSync(`${GEONAMES_DUMP}/${subdir}`);
        }

        fs.writeFileSync(timestampedFilename, body);
        // Housekeeping, remove old files
        const currentFileName = path.basename(timestampedFilename);
        fs.readdirSync(`${GEONAMES_DUMP}/${subdir}`).forEach((file) => {
          if (file !== currentFileName) {
            fs.unlinkSync(`${GEONAMES_DUMP}/${subdir}/${file}`);
          }
        });
        return callback(null, timestampedFilename);
      }
    );
  },

  "_getGeoNamesAlternateNamesData" (callback) {
    return this._getGeoDataZipFile(
      callback,
      'alternate_names',
      ALTERNATE_NAMES_FILE,
      'alternate names'
    );
  },

  "_parseGeoNamesAlternateNamesCsv" (pathToCsv, callback) {
    const that = this;
    that._alternateNames = {};
    const lineReader = readline.createInterface({
      "input": fs.createReadStream(pathToCsv)
    });
    lineReader.on('line',
      (line) => {
        line = line.split('\t');

        /* eslint-disable no-unused-vars */
        // Caveat: we are not saving the is* properties since we are basically only
        // interested in the prinary (only, first, or designated preferred) localized name
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
        /* eslint-enable no-unused-vars */

        // Require valid language
        if (Boolean(isoLanguage) && isoLanguage !== 'link') {
          if (!that._alternateNames[geoNameId]) {
            that._alternateNames[geoNameId] = {};
          }
          if (!that._alternateNames[geoNameId][isoLanguage] || isPreferredName === '1') {

            /*
             * The following construct seems weird, but saves lots of heap
             * space (hundreds of megabytes) because the sliced strings are released.
             */
            that._alternateNames[geoNameId][isoLanguage] = JSON.parse(JSON.stringify(altName));
          }
        }
      }
    ).on('close',
      () => callback()
    );
  },

  "_getGeoNamesCountryInfoData" (callback) {
    return this._getGeoDataTextFile(
      callback,
      'country_info',
      COUNTRY_INFO_FILE,
      'country'
    );
  },

  "_parseGeoNamesCountryInfoCsv" (pathToCsv, callback) {
    const that = this;
    that._countryInfo = {};
    const lineReader = readline.createInterface({
      "input": fs.createReadStream(pathToCsv)
    });

    lineReader.on('line',
      (line) => {
        line = line.split('\t');
        const countryGeoId = line[16];
        if (line[0] !== '' && Boolean(countryGeoId)) {
          that._countryInfo[line[0]] = {};
          that._countryInfo[line[0]].geoId = countryGeoId;
          if (that._alternateNames[countryGeoId]) {
            that._countryInfo[line[0]].alternateNames = that._alternateNames[countryGeoId];
          }
        }
      }
    ).on('close',
      () => callback()
    );
  },

  "_getGeoNamesAdmin1CodesData" (callback) {
    return this._getGeoDataTextFile(
      callback,
      'admin1_codes',
      ADMIN_1_CODES_FILE,
      'admin 1 codes'
    );
  },

  "_parseGeoNamesAdmin1CodesCsv" (pathToCsv, callback) {
    const that = this,
      lenI = GEONAMES_ADMIN_CODES_COLUMNS.length;
    that._admin1Codes = {};
    const lineReader = readline.createInterface({
      "input": fs.createReadStream(pathToCsv)
    });
    lineReader.on('line',
      (line) => {
        line = line.split('\t');
        for (let i = 0; i < lenI; i += 1) {
          const value = line[i] || null;
          if (i === 0) {
            that._admin1Codes[value] = {};
          } else {
            that._admin1Codes[line[0]][GEONAMES_ADMIN_CODES_COLUMNS[i]] = value;
          }
        }
        if (that._alternateNames[line[3]]) {
          that._admin1Codes[line[0]].alternateNames = that._alternateNames[line[3]];
        }
      }
    ).on('close',
      () => callback()
    );
  },

  "_getGeoNamesAdmin2CodesData" (callback) {
    return this._getGeoDataTextFile(
      callback,
      'admin2_codes',
      ADMIN_2_CODES_FILE,
      'admin 2 codes'
    );
  },

  "_parseGeoNamesAdmin2CodesCsv" (pathToCsv, callback) {
    const that = this,
      lenI = GEONAMES_ADMIN_CODES_COLUMNS.length;
    that._admin2Codes = {};
    const lineReader = readline.createInterface({
      "input": fs.createReadStream(pathToCsv)
    });
    lineReader.on('line',
      (line) => {
        line = line.split('\t');
        for (let i = 0; i < lenI; i += 1) {
          const value = line[i] || null;
          if (i === 0) {
            that._admin2Codes[value] = {};
          } else {
            that._admin2Codes[line[0]][GEONAMES_ADMIN_CODES_COLUMNS[i]] = JSON.parse(JSON.stringify(value));
          }
        }
        if (that._alternateNames[line[3]]) {
          that._admin2Codes[line[0]].alternateNames = that._alternateNames[line[3]];
        }
      }
    ).on('close',
      () => callback()
    );
  },

  "_getGeoNamesCitiesData" (callback) {
    return this._getGeoDataZipFile(
      callback,
      'cities',
      CITIES_FILE,
      'cities'
    );
  },

  "_parseGeoNamesCitiesCsv" (pathToCsv, callback) {
    debug('Started parsing cities.txt (this may take a ' +
      'while)');
    const data = [],
      lenI = GEONAMES_COLUMNS.length,
      that = this,
      latitudeIndex = GEONAMES_COLUMNS.indexOf('latitude'),
      longitudeIndex = GEONAMES_COLUMNS.indexOf('longitude'),

      lineReader = readline.createInterface({
        "input": fs.createReadStream(pathToCsv)
      });

    lineReader.on('line',
      (line) => {
        const lineObj = {};
        line = JSON.parse(JSON.stringify(line)).split('\t');

        for (let i = 0; i < lenI; i += 1) {
          const column = line[i] || null;
          lineObj[GEONAMES_COLUMNS[i]] = column;
        }

        const lng = lineObj[GEONAMES_COLUMNS[latitudeIndex]],
          lat = lineObj[GEONAMES_COLUMNS[longitudeIndex]];
        // Do not add locations without lat/lng pair
        if (lng !== null && lng !== undefined && !isNaN(lng) &&
          lat !== null && lat !== undefined && !isNaN(lat)) {
          if (that._alternateNames[lineObj.geoNameId]) {
            const alt = that._alternateNames[lineObj.geoNameId] || null;
            for (const x in alt) {
              if (alt[x] === lineObj.name) {
                delete alt[x];
              }
            }
            lineObj.alternateNames = alt;
          }
          data.push(lineObj);
        }
      }
    ).on('close',
      () => {
        debug('Finished parsing cities.txt');
        debug('Started building cities k-d tree (this may take ' +
      'a while)');

        const dimensions = [
          'latitude',
          'longitude'
        ];
        that._kdTree = kdTree.createKdTree(
          data,
          that._distanceFunc,
          dimensions
        );
        debug('Finished building cities k-d tree');
        return callback();
      }
    );
  },

  "_getGeoNamesAllCountriesData" (callback) {
    return this._getGeoDataZipFile(
      callback,
      'all_countries',
      ALL_COUNTRIES_FILE,
      'all countries'
    );
  },

  "_parseGeoNamesAllCountriesCsv" (pathToCsv, callback) {
    debug('Started parsing all countries.txt (this  may take ' +
      'a while)');
    const that = this;
    // Indexes
    const admin1CodeIndex = GEONAMES_COLUMNS.indexOf('admin1Code'),
      admin2CodeIndex = GEONAMES_COLUMNS.indexOf('admin2Code'),
      admin3CodeIndex = GEONAMES_COLUMNS.indexOf('admin3Code'),
      admin4CodeIndex = GEONAMES_COLUMNS.indexOf('admin4Code'),
      asciiNameIndex = GEONAMES_COLUMNS.indexOf('asciiName'),
      countryCodeIndex = GEONAMES_COLUMNS.indexOf('countryCode'),
      featureCodeIndex = GEONAMES_COLUMNS.indexOf('featureCode'),
      geoNameIdIndex = GEONAMES_COLUMNS.indexOf('geoNameId'),
      nameIndex = GEONAMES_COLUMNS.indexOf('name');

    let counter = 0;
    that._admin3Codes = {};
    that._admin4Codes = {};
    const lineReader = readline.createInterface({
      "input": fs.createReadStream(pathToCsv)
    });
    lineReader.on('line',
      (line) => {
        line = line.split('\t');
        const featureCode = line[featureCodeIndex];
        if (featureCode === 'ADM3' || featureCode === 'ADM4') {
          const lineObj = {
              "asciiName": line[asciiNameIndex],
              "geoNameId": line[geoNameIdIndex],
              "name": line[nameIndex]
            },
            key = `${line[countryCodeIndex]}.${line[admin1CodeIndex]}.${
              line[admin2CodeIndex]}.${line[admin3CodeIndex]}`;
          if (featureCode === 'ADM3') {
            that._admin3Codes[key] = lineObj;
          } else if (featureCode === 'ADM4') {
            that._admin4Codes[`${key}.${line[admin4CodeIndex]}`] = lineObj;
          }
        }
        if (counter % 100000 === 0) {
          debug(`Parsing progress all countries: ${counter}`);
        }
        counter += 1;
      }
    ).on('close',
      () => {
        debug('Finished parsing all countries.txt');
        return callback();
      }
    );
  },

  "init" (options, callback) {
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

    debug(`${'Initializing local reverse geocoder using dump ' +
      'directory: '}${GEONAMES_DUMP}`);
    // Create local cache folder
    if (!fs.existsSync(GEONAMES_DUMP)) {
      fs.mkdirSync(GEONAMES_DUMP);
    }
    const that = this;

    /*
     * Have to use series here to ensure alternate names are available
     * when parsing the actual cities/admin areas
     */
    async.series(
      [
        // Get GeoNames cities
        function (waterfallCallback) {
          async.waterfall(
            [
              that._getGeoNamesAlternateNamesData.bind(that),
              that._parseGeoNamesAlternateNamesCsv.bind(that),

              that._getGeoNamesCitiesData.bind(that),
              that._parseGeoNamesCitiesCsv.bind(that)
            ],
            () => waterfallCallback()
          );
        },
        // Get GeoNames countries
        function (waterfallCallback) {
          async.waterfall(
            [
              that._getGeoNamesCountryInfoData.bind(that),
              that._parseGeoNamesCountryInfoCsv.bind(that)
            ],
            () => waterfallCallback()
          );
        },
        // Get GeoNames admin 1 codes
        function (waterfallCallback) {
          if (options.load.admin1) {
            async.waterfall(
              [
                that._getGeoNamesAdmin1CodesData.bind(that),
                that._parseGeoNamesAdmin1CodesCsv.bind(that)
              ],
              () => waterfallCallback()
            );
          } else {
            return setImmediate(waterfallCallback);
          }
        },
        // Get GeoNames admin 2 codes
        function (waterfallCallback) {
          if (options.load.admin2) {
            async.waterfall(
              [
                that._getGeoNamesAdmin2CodesData.bind(that),
                that._parseGeoNamesAdmin2CodesCsv.bind(that)
              ],
              () => waterfallCallback()
            );
          } else {
            return setImmediate(waterfallCallback);
          }
        },
        // Get GeoNames all countries
        function (waterfallCallback) {
          if (options.load.admin3And4) {
            async.waterfall(
              [
                that._getGeoNamesAllCountriesData.bind(that),
                that._parseGeoNamesAllCountriesCsv.bind(that)
              ],
              () => waterfallCallback()
            );
          } else {
            return setImmediate(waterfallCallback);
          }
        }
      ],
      // Main callback
      (err) => {
        that._alternateNames = null;

        if (err) {
          throw err;
        }
        return callback();
      }
    );
  },

  "lookUp" (points, arg2, arg3) {
    let callback,
      maxResults;
    if (arguments.length === 2) {
      maxResults = 1;
      callback = arg2;
    } else {
      maxResults = arg2;
      callback = arg3;
    }
    this._lookUp(
      points,
      maxResults,
      (err, results) => callback(
        err,
        results
      )
    );
  },

  "_lookUp" (points, maxResults, callback) {
    const that = this;
    // If not yet initialied, then bail out
    if (!this._kdTree) {
      return callback('{}', null);

      /*
       * TODO: make non-preload work again while avoiding init retries on every call
       *       In case of failing init
       */
      /*
       *return this.init({}, function() {
       *  return that.lookUp(points, maxResults, callback);
       *});
       */
    }
    // Make sure we have an array of points
    if (!Array.isArray(points)) {
      points = [points];
    }
    let functions = [];
    points.forEach((point, i) => {
      point = {
        "latitude": parseFloat(point.latitude),
        "longitude": parseFloat(point.longitude)
      };
      debug(`Look-up request for point ${JSON.stringify(point)}`);
      functions[i] = function (innerCallback) {
        let result = that._kdTree.nearest(
          point,
          maxResults + 3
        );

        /*
         * Get a few more results above, then select the best ones weighted by distance and population
         * (add pop. 100 to accomodate tiny places or unknown population count)
         */
        result.sort((a, b) => (100 + Number(b[0].population)) * a[1] * a[1] - (100 + Number(a[0].population)) * b[1] * b[1]);
        result = result.slice(0, maxResults);

        for (let j = 0, lenJ = result.length; j < lenJ; j += 1) {
          if (result && result[j] && result[j][0]) {
            let countryCode = result[j][0].countryCode || '',
              geoNameId = result[j][0].geoNameId || '',
              admin1Code,
              admin2Code,
              admin3Code,
              admin4Code;
            // Look-up of admin 1 code
            if (that._admin1Codes) {
              admin1Code = result[j][0].admin1Code || '';
              const admin1CodeKey = `${countryCode}.${admin1Code}`;
              result[j][0].admin1Code = that._admin1Codes[admin1CodeKey] ||
                result[j][0].admin1Code;
            }
            // Look-up of admin 2 code
            if (that._admin2Codes) {
              admin2Code = result[j][0].admin2Code || '';
              const admin2CodeKey = `${countryCode}.${admin1Code}.${
                admin2Code}`;
              result[j][0].admin2Code = that._admin2Codes[admin2CodeKey] ||
                result[j][0].admin2Code;
            }
            // Look-up of admin 3 code
            if (that._admin3Codes) {
              admin3Code = result[j][0].admin3Code || '';
              const admin3CodeKey = `${countryCode}.${admin1Code}.${
                admin2Code}.${admin3Code}`;
              result[j][0].admin3Code = that._admin3Codes[admin3CodeKey] ||
                result[j][0].admin3Code;
            }
            // Look-up of admin 4 code
            if (that._admin4Codes) {
              admin4Code = result[j][0].admin4Code || '';
              const admin4CodeKey = `${countryCode}.${admin1Code}.${
                admin2Code}.${admin3Code}.${admin4Code}`;
              result[j][0].admin4Code = that._admin4Codes[admin4CodeKey] ||
                result[j][0].admin4Code;
            }
            // Look-up of country alternate names
            if (that._countryInfo[countryCode]) {
              result[j][0].countryAltNames = that._countryInfo[countryCode].alternateNames;
            }

            // Pull in the k-d tree distance in the main object
            result[j][0].distance = result[j][1];
            // Simplify the output by not returning an array
            result[j] = result[j][0];
          }
        }

        /*
         *      Debug('Found result(s) for point ' +
         *          JSON.stringify(point) + result.map(function(subResult, i) {
         *            return '\n  (' + (++i) + ') {"geoNameId":"' +
         *                subResult.geoNameId + '",' + '"name":"' + subResult.name +
         *                '"}';
         *          }));
         */
        return innerCallback(null, result);
      };
    });
    async.series(
      functions,
      (err, results) => {
        debug('Delivering joint results');
        return callback(null, results);
      }
    );
  }
};

module.exports = geocoder;
