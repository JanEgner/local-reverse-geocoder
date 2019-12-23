'use strict';
const app = require('express')();
const fs = require('fs');
const geocoder = require('./geocoder.js');
const http = require('http');
const https = require('https');

let credentials;
try {
  const privateKey = fs.readFileSync('cert/server.key', 'utf8'),
    certificate = fs.readFileSync('cert/server.crt', 'utf8');
  credentials = {"cert": certificate,
    "key": privateKey,
    "secureProtocol": 'TLSv1_2_method'};
} catch (ex) {
  console.log('No certificate - no TLS!');
}

const INVALID = 400,
  FAILURE = 500;

app.get(
  /geocode/,
  (req, res) => {
    let lat = req.query.latitude || false,
      lon = req.query.longitude || false;
    const lang = req.query.language || req.acceptsLanguages()[0] && req.acceptsLanguages()[0].substr(0, 2).toLowerCase(),
      latlng = req.query.latlng || false,
      maxResults = req.query.maxResults || 1;

    if (latlng) {
      const components = latlng.split(',');
      if (components.length === 2) {
        [lat, lon] = components;
      }
    }

    if (!lat || !lon) {
      return res.status(INVALID).send('Bad Request');
    }
    const points = [];
    if (Array.isArray(lat) && Array.isArray(lon)) {
      if (lat.length !== lon.length) {
        return res.status(INVALID).send('Bad Request');
      }
      for (let i = 0; i < lat.length; i += 1) {
        if (lat[i].indexOf(':') > 0) {
          const components = lat[i].split(':');
          lat[i] = Number(components[0]) + Math.sign(components[0]) * (Number(components[1]) / 60 + Number(components[2] || 0) / 3600);
        }
        if (lon[i].indexOf(':') > 0) {
          const components = lon[i].split(':');
          lon[i] = Number(components[0]) + Math.sign(components[0]) * (Number(components[1]) / 60 + Number(components[2] || 0) / 3600);
        }
        points[i] = {"latitude": Number(lat[i]),
          "longitude": Number(lon[i])};
      }
    } else {
      if (lat.indexOf(':') > 0) {
        const components = lat.split(':');
        lat = Number(components[0]) + Math.sign(components[0]) * (Number(components[1]) / 60 + Number(components[2] || 0) / 3600);
      }
      if (lon.indexOf(':') > 0) {
        const components = lon.split(':');
        lon = Number(components[0]) + Math.sign(components[0]) * (Number(components[1]) / 60 + Number(components[2] || 0) / 3600);
      }
      points[0] = {"latitude": Number(lat),
        "longitude": Number(lon)};
    }
    geocoder.lookUp(
      points,
      maxResults,
      (err, addresses) => {
        if (err) {
          return res.status(FAILURE).send(err);
        }
        if (latlng) {
          return res.send(googlify(
            addresses,
            lang
          ));
        } else if (req.query.language) {
          const ret = {};
          ret.dispname = prettify(
            addresses,
            lang
          );
          ret.distance = addresses[0][0].distance;
          return res.send(ret);
        }
        return res.send(addresses);
      }
    );
    return false;
  }
);

function prettify (address, language) {
  let lang = language;
  if (!language || language === '') {
    lang = 'invalid';
  }
  const add = address[0][0];
  if (!add) {
    return null;
  }

  let res = add.alternateNames && add.alternateNames[lang] || add.name;
  if (add.admin1Code) {
    res = `${res}, ${add.admin1Code.alternateNames && add.admin1Code.alternateNames[lang] || add.admin1Code.name}`;
  }
  if (add.countryCode) {
    res = `${res}, ${add.countryAltNames && (add.countryAltNames[lang] || add.countryAltNames.en) || add.countryCode}`;
  }
  return res;
}

function googlify (address, language) {
  let lang = language;
  if (!language || language === '') {
    lang = 'invalid';
  }
  const add = address[0][0];
  if (!add) {
    return null;
  }

  const ret = {};
  ret.results = [
    {
      "address_components": [
        {
          "long_name": add.alternateNames && add.alternateNames[lang] || add.name,
          "short_name": add.alternateNames && add.alternateNames[lang] || add.name,
          "types": ['locality']
        },
        {
          "long_name": add.countryAltNames && (add.countryAltNames[lang] || add.countryAltNames.en) || add.countryCode,
          "short_name": add.countryAltNames && (add.countryAltNames[lang] || add.countryAltNames.en) || add.countryCode,
          "types": ['country']
        }
      ],
      "formatted_address": prettify(
        address,
        lang
      ),
      "geometry": {
        "location": {
          "lat": add.latitude,
          "lng": add.longitude
        },
        "location_type": 'GEOMETRIC_CENTER'
      }
    }
  ];
  ret.status = 'OK';
  if (add.admin2Code && add.admin2Code.name) {
    ret.results[0].address_components.push({
      "long_name": add.admin2Code.alternateNames && add.admin2Code.alternateNames[lang] || add.admin2Code.name,
      "short_name": add.admin2Code.alternateNames && add.admin2Code.alternateNames[lang] || add.admin2Code.name,
      "types": ['administrative_area_level_2']
    });
  }
  if (add.admin1Code && add.admin1Code.name) {
    ret.results[0].address_components.push({
      "long_name": add.admin1Code.alternateNames && add.admin1Code.alternateNames[lang] || add.admin1Code.name,
      "short_name": add.admin1Code.alternateNames && add.admin1Code.alternateNames[lang] || add.admin1Code.name,
      "types": ['administrative_area_level_1']
    });
  }
  return ret;
}

const DEFAULT_HTTP_PORT = 3000,
  DEFAULT_HTTPS_PORT = 3001;

geocoder.init(
  {},
  () => {
    const port = Number(process.env.PORT || DEFAULT_HTTP_PORT),
      portSecure = Number(process.env.PORTTLS || DEFAULT_HTTPS_PORT);

    if (port > 0) {
      const httpServer = http.createServer(app);
      if (httpServer !== undefined) {
        httpServer.listen(port);
      }
    }
    if (credentials !== undefined && portSecure > 0) {
      const httpsServer = https.createServer(credentials, app);
      if (httpsServer !== undefined) {
        httpsServer.listen(portSecure);
      }
    }

    console.log('Local reverse geocoder listening');
  }
);
