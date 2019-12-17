'use strict';

var fs = require('fs');
var http = require('http');
var https = require('https');

try {
  var privateKey  = fs.readFileSync('cert/server.key', 'utf8');
  var certificate = fs.readFileSync('cert/server.crt', 'utf8');
  var credentials = {key: privateKey, cert: certificate, secureProtocol: 'TLSv1_2_method'};
} catch (e) {
  console.log ('No certificate - no TLS!');
}

var express = require('express');
var app = express();
var geocoder = require('./geocoder.js');

app.get(/geocode/, function(req, res) {
  var lat = req.query.latitude || false;
  var lon = req.query.longitude || false;
  var latlng = req.query.latlng || false;
  var maxResults = req.query.maxResults || 1;
  var lang = req.query.language || (req.acceptsLanguages()[0] && req.acceptsLanguages()[0].substr(0, 2).toLowerCase());
  if (!! latlng) {
    var components=latlng.split(',');
    if (components.length == 2) {
      lat=components[0];
      lon=components[1];
    }
  }

  if (!lat || !lon) {
    return res.status(400).send('Bad Request');
  }
  var points = [];
  if (Array.isArray(lat) && Array.isArray(lon)) {
    if (lat.length !== lon.length) {
      return res.status(400).send('Bad Request');
    }
    for (var i = 0, lenI = lat.length; i < lenI; i++) {
      if (lat[i].indexOf(':') > 0) {
        var components=lat[i].split(':');
        lat[i]=Number(components[0])+Math.sign(components[0])*(Number(components[1])/60+Number(components[2] || 0)/3600);
      }
      if (lon[i].indexOf(':') > 0) {
        var components=lon[i].split(':');
        lon[i]=Number(components[0])+Math.sign(components[0])*(Number(components[1])/60+Number(components[2] || 0)/3600);
      }
      points[i] = {latitude: Number(lat[i]), longitude: Number(lon[i])};
    }
  } else {
    if (lat.indexOf(':') > 0) {
      var components=lat.split(':');
      lat=Number(components[0])+Math.sign(components[0])*(Number(components[1])/60+Number(components[2] || 0)/3600);
    }
    if (lon.indexOf(':') > 0) {
      var components=lon.split(':');
      lon=Number(components[0])+Math.sign(components[0])*(Number(components[1])/60+Number(components[2] || 0)/3600);
    }
    points[0] =  {latitude: Number(lat), longitude: Number(lon)};
  }
  geocoder.lookUp(points, maxResults, function(err, addresses) {
    if (err) {
      return res.status(500).send(err);
    }
    if (!! latlng) {
      return res.send(googlify(addresses, lang));
    } else if (!! req.query.language) {
      var ret = {};
      ret.dispname = prettify(addresses, lang);
      ret.distance = addresses[0][0].distance;
      return res.send(ret);
    }
    return res.send(addresses);
  });
});

function prettify(address,language) {
  if (!language || language=='')
    language='invalid';
  var add=address[0][0];
  if (! add)
    return null;

  var res = (add.alternateNames && add.alternateNames[language]) || add.name;
  if (add.admin1Code)
    res = res + ", " + ((add.admin1Code.alternateNames && add.admin1Code.alternateNames[language]) || add.admin1Code.name);
  if (add.countryCode)
    res = res + ", " + ((add.countryAltNames && (add.countryAltNames[language] || add.countryAltNames['en'])) || add.countryCode);
  return res;
};

function googlify(address,language) {
  if (!language || language=='')
    language='invalid';
  var add=address[0][0];
  if (! add)
    return null;

  var ret={};
  ret.results = [{
    formatted_address: prettify(address, language),
    geometry: {
      location: {
        lat: add.latitude,
        lng: add.longitude
      },
      location_type: 'GEOMETRIC_CENTER'
    },
    address_components: [{
      long_name: (add.alternateNames && add.alternateNames[language]) || add.name,
      short_name: (add.alternateNames && add.alternateNames[language]) || add.name,
      types: ['locality']
    }, {
      long_name: ((add.countryAltNames && (add.countryAltNames[language] || add.countryAltNames['en'])) || add.countryCode),
      short_name: ((add.countryAltNames && (add.countryAltNames[language] || add.countryAltNames['en'])) || add.countryCode),
      types: ['country']
    }]
  }];
  ret.status = 'OK';
  if (add.admin2Code && add.admin2Code.name) {
    ret.results[0].address_components.push({
      long_name: ((add.admin2Code.alternateNames && add.admin2Code.alternateNames[language]) || add.admin2Code.name),
      short_name:((add.admin2Code.alternateNames && add.admin2Code.alternateNames[language]) || add.admin2Code.name),
      types: ['administrative_area_level_2']
    });
  };
  if (add.admin1Code && add.admin1Code.name) {
    ret.results[0].address_components.push({
      long_name: ((add.admin1Code.alternateNames && add.admin1Code.alternateNames[language]) || add.admin1Code.name),
      short_name:((add.admin1Code.alternateNames && add.admin1Code.alternateNames[language]) || add.admin1Code.name),
      types: ['administrative_area_level_1']
    });
  };
  return ret;
}

geocoder.init({}, function() {
  var port = Number(process.env.PORT || 3000);
  var portSecure = Number(process.env.PORTTLS || 3001);

  if (port > 0)
    var httpServer = http.createServer(app);
  if (credentials!==undefined && portSecure > 0)
    var httpsServer = https.createServer(credentials, app);

  if (httpServer!==undefined)
    httpServer.listen(port);
  if (httpsServer!==undefined)
    httpsServer.listen(portSecure);
  console.log('Local reverse geocoder listening');
});
