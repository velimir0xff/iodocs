//
// Copyright (c) 2011 Mashery, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// 'Software'), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

//
// Module dependencies
//
var express     = require('express'),
    util        = require('util'),
    fs          = require('fs'),
    OAuth       = require('oauth').OAuth,
    query       = require('querystring'),
    url         = require('url'),
    http        = require('http'),
    https       = require('https'),
    crypto      = require('crypto'),
    redis       = require('redis'),
    pathy       = require('path'),
    RedisStore  = require('connect-redis')(express);

// Configuration
try {
    var config = require('./config.json');
} catch(e) {
    console.error("File config.json not found or is invalid.  Try: `cp config.json.sample config.json`");
    process.exit(1);
}

//
// Redis connection
//
var defaultDB = '0';
var db;

if (process.env.REDISTOGO_URL) {
    var rtg   = require("url").parse(process.env.REDISTOGO_URL);
    db = require("redis").createClient(rtg.port, rtg.hostname);
    db.auth(rtg.auth.split(":")[1]);
} else {
    db = redis.createClient(config.redis.port, config.redis.host);
    db.auth(config.redis.password);
}

db.on("error", function(err) {
    if (config.debug) {
         console.log("Error " + err);
    }
});

//
// Load API Configs
//

try {
    var apisConfig = require('./public/data/apiconfig.json');
    if (config.debug) {
        console.log(util.inspect(apisConfig));
    }
} catch(e) {
    console.error("File apiconfig.json not found or is invalid.");
    process.exit(1);
}

//
// Determine if we should launch as http/s and get keys and certs if needed
//

var app, httpsKey, httpsCert;

if (config.https && config.https.on && config.https.keyPath && config.https.certPath) {
    console.log("Starting secure server (https)");

    // try reading the key and cert files, die if that fails
    try {
        httpsKey = fs.readFileSync(config.https.keyPath);
    } 
    catch (err) {
        console.error("Failed to read https key", config.https.keyPath);
        console.log(err);
        process.exit(1);
    }
    try {
        httpsCert = fs.readFileSync(config.https.certPath);
    }
    catch (err) {
        console.error("Failed to read https cert", config.https.certPath);
        console.log(err);
        process.exit(1);
    }

    app = module.exports = express.createServer({
        key: httpsKey,
        cert: httpsCert        
    });

}
else if (config.https && config.https.on) {
    console.error("No key or certificate specified.");
    process.exit(1);
}
else {
    app = module.exports = express.createServer();
}

if (process.env.REDISTOGO_URL) {
    var rtg   = require("url").parse(process.env.REDISTOGO_URL);
    config.redis.host = rtg.hostname;
    config.redis.port = rtg.port;
    config.redis.password = rtg.auth.split(":")[1];
}

app.configure(function() {
    app.set('views', __dirname + '/views');
    app.set('view engine', 'jade');
    app.use(express.logger());
    app.use(express.bodyParser());
    app.use(express.methodOverride());
    app.use(express.cookieParser());
    app.use(express.session({
        secret: config.sessionSecret,
        store:  new RedisStore({
            'host':   config.redis.host,
            'port':   config.redis.port,
            'pass':   config.redis.password,
            'maxAge': 1209600000
        })
    }));

    // Global basic authentication on server (applied if configured)
    if (config.basicAuth && config.basicAuth.username && config.basicAuth.password) {
        app.use(express.basicAuth(function(user, pass, callback) {
            var result = (user === config.basicAuth.username && pass === config.basicAuth.password);
            callback(null /* error */, result);
        }));
    }

    app.use(app.router);

    app.use(express.static(__dirname + '/public'));
});

app.configure('development', function() {
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function() {
    app.use(express.errorHandler());
});

//
// Middleware
//
function oauth(req, res, next) {
    console.log('OAuth process started');
    var apiName = req.body.apiName,
        apiConfig = apisConfig[apiName];

    if (apiConfig.oauth) {
        var apiKey = req.body.apiKey || req.body.key,
            apiSecret = req.body.apiSecret || req.body.secret,
            refererURL = url.parse(req.headers.referer),
            callbackURL = refererURL.protocol + '//' + refererURL.host + '/authSuccess/' + apiName,
            oa = new OAuth(apiConfig.oauth.requestURL,
                           apiConfig.oauth.accessURL,
                           apiKey,
                           apiSecret,
                           apiConfig.oauth.version,
                           callbackURL,
                           apiConfig.oauth.crypt);

        if (config.debug) {
            console.log('OAuth type: ' + apiConfig.oauth.type);
            console.log('Method security: ' + req.body.oauth);
            console.log('Session authed: ' + req.session[apiName]);
            console.log('apiKey: ' + apiKey);
            console.log('apiSecret: ' + apiSecret);
        };

        // Check if the API even uses OAuth, then if the method requires oauth, then if the session is not authed
        if (apiConfig.oauth.type == 'three-legged' && req.body.oauth == 'authrequired' && (!req.session[apiName] || !req.session[apiName].authed) ) {
            if (config.debug) {
                console.log('req.session: ' + util.inspect(req.session));
                console.log('headers: ' + util.inspect(req.headers));

                console.log(util.inspect(oa));
                // console.log(util.inspect(req));
                console.log('sessionID: ' + util.inspect(req.sessionID));
                // console.log(util.inspect(req.sessionStore));
            };

            oa.getOAuthRequestToken(function(err, oauthToken, oauthTokenSecret, results) {
                if (err) {
                    res.send("Error getting OAuth request token : " + util.inspect(err), 500);
                } else {
                    // Unique key using the sessionID and API name to store tokens and secrets
                    var key = req.sessionID + ':' + apiName;

                    db.set(key + ':apiKey', apiKey, redis.print);
                    db.set(key + ':apiSecret', apiSecret, redis.print);

                    db.set(key + ':requestToken', oauthToken, redis.print);
                    db.set(key + ':requestTokenSecret', oauthTokenSecret, redis.print);

                    // Set expiration to same as session
                    db.expire(key + ':apiKey', 1209600000);
                    db.expire(key + ':apiSecret', 1209600000);
                    db.expire(key + ':requestToken', 1209600000);
                    db.expire(key + ':requestTokenSecret', 1209600000);

                    // res.header('Content-Type', 'application/json');
                    res.send({ 'signin': apiConfig.oauth.signinURL + oauthToken });
                }
            });
        } else if (apiConfig.oauth.type == 'two-legged' && req.body.oauth == 'authrequired') {
            // Two legged stuff... for now nothing.
            next();
        } else {
            next();
        }
    } else {
        next();
    }

}

//
// OAuth Success!
//
function oauthSuccess(req, res, next) {
    var oauthRequestToken,
        oauthRequestTokenSecret,
        apiKey,
        apiSecret,
        apiName = req.params.api,
        apiConfig = apisConfig[apiName],
        key = req.sessionID + ':' + apiName; // Unique key using the sessionID and API name to store tokens and secrets

    if (config.debug) {
        console.log('apiName: ' + apiName);
        console.log('key: ' + key);
        console.log(util.inspect(req.params));
    };

    db.mget([
        key + ':requestToken',
        key + ':requestTokenSecret',
        key + ':apiKey',
        key + ':apiSecret'
    ], function(err, result) {
        if (err) {
            console.log(util.inspect(err));
        }
        oauthRequestToken = result[0],
        oauthRequestTokenSecret = result[1],
        apiKey = result[2],
        apiSecret = result[3];

        if (config.debug) {
            console.log(util.inspect(">>"+oauthRequestToken));
            console.log(util.inspect(">>"+oauthRequestTokenSecret));
            console.log(util.inspect(">>"+req.query.oauth_verifier));
        };

        var oa = new OAuth(apiConfig.oauth.requestURL,
                           apiConfig.oauth.accessURL,
                           apiKey,
                           apiSecret,
                           apiConfig.oauth.version,
                           null,
                           apiConfig.oauth.crypt);

        if (config.debug) {
            console.log(util.inspect(oa));
        };

        oa.getOAuthAccessToken(oauthRequestToken, oauthRequestTokenSecret, req.query.oauth_verifier, function(error, oauthAccessToken, oauthAccessTokenSecret, results) {
            if (error) {
                res.send("Error getting OAuth access token : " + util.inspect(error) + "["+oauthAccessToken+"]"+ "["+oauthAccessTokenSecret+"]"+ "["+util.inspect(results)+"]", 500);
            } else {
                if (config.debug) {
                    console.log('results: ' + util.inspect(results));
                };
                db.mset([key + ':accessToken', oauthAccessToken,
                    key + ':accessTokenSecret', oauthAccessTokenSecret
                ], function(err, results2) {
                    req.session[apiName] = {};
                    req.session[apiName].authed = true;
                    if (config.debug) {
                        console.log('session[apiName].authed: ' + util.inspect(req.session));
                    };

                    next();
                });
            }
        });

    });
}

//
// processRequest - handles API call
//
function processRequest(req, res, next) {
    if (config.debug) {
        console.log(util.inspect(req.body, null, 3));
    };

    var reqQuery = req.body,
        customHeaders = {},
        params = reqQuery.params || {},
        content = reqQuery.requestContent || '',
        contentType = reqQuery.contentType || '',
        locations = reqQuery.locations || {},
        methodURL = reqQuery.methodUri,
        httpMethod = reqQuery.httpMethod,
        apiKey = reqQuery.apiKey,
        apiSecret = reqQuery.apiSecret,
        apiName = reqQuery.apiName,
        apiConfig = apisConfig[apiName],
        key = req.sessionID + ':' + apiName;

    // Extract custom headers from the params
    for( var param in params ) 
    {
         if (params.hasOwnProperty(param)) 
         {
            if (params[param] !== '' && locations[param] == 'header' ) 
            {
                customHeaders[param] = params[param];
                delete params[param];
            }
         }
    }

    // Replace placeholders in the methodURL with matching params
    for (var param in params) {
        if (params.hasOwnProperty(param)) {
            // URL params are prepended with ":"
            var regx = new RegExp(':' + param);
            
            // If the param is actually a part of the URL, put it in the URL and remove the param
            if (!!regx.test(methodURL)) {
                methodURL = methodURL.replace(regx, params[param]);
                delete params[param]
            }

            // if the param wasn't already deleted and is blank, delete it
            if (params.hasOwnProperty(param) && params[param] == '') {
                delete params[param];
            }
        }
    }

    // Delete empty optional blocks of the methodURL (wrapped in []) after parameter filling
    var emptyBlock = new RegExp(/\[\/*?\]/);
    while (!!emptyBlock.test(methodURL)) {
        methodURL = methodURL.replace(emptyBlock, '');
    }

    // Delete brackets ('[' and ']') from filled-out optional blocks of the methodURL.
    var brackets = new RegExp(/[\[\]]/);
    while (!!brackets.test(methodURL)) {
        methodURL = methodURL.replace(brackets, '');
    }

    var baseHostInfo = apiConfig.baseURL.split(':');
    var baseHostUrl = baseHostInfo[0],
        baseHostPort = (baseHostInfo.length > 1) ? baseHostInfo[1] : "";
    var headers = {};
    for( header in apiConfig.headers )
        headers[header] = apiConfig.headers[header];
    for( header in customHeaders )
        headers[header] = customHeaders[header];

    var paramString = query.stringify(params),
        privateReqURL = apiConfig.protocol + '://' + apiConfig.baseURL + apiConfig.privatePath + methodURL + ((paramString.length > 0) ? '?' + paramString : ""),
        options = {
            headers: headers,
            protocol: apiConfig.protocol + ':',
            host: baseHostUrl,
            port: baseHostPort,
            method: httpMethod,
            path: apiConfig.publicPath + methodURL + ((paramString.length > 0) ? '?' + paramString : ""),
            rejectUnauthorized: false
        };

    // set requestHeaders to pass back for display
    req.requestHeaders = options.headers;

    if (apiConfig.oauth) {
        console.log('Using OAuth');

        // Three legged OAuth
        if (apiConfig.oauth.type == 'three-legged' && (reqQuery.oauth == 'authrequired' || (req.session[apiName] && req.session[apiName].authed))) {
            if (config.debug) {
                console.log('Three Legged OAuth');
            };

            db.mget([key + ':apiKey',
                     key + ':apiSecret',
                     key + ':accessToken',
                     key + ':accessTokenSecret'
                ],
                function(err, results) {

                    var apiKey = (typeof reqQuery.apiKey == "undefined" || reqQuery.apiKey == "undefined")?results[0]:reqQuery.apiKey,
                        apiSecret = (typeof reqQuery.apiSecret == "undefined" || reqQuery.apiSecret == "undefined")?results[1]:reqQuery.apiSecret,
                        accessToken = results[2],
                        accessTokenSecret = results[3];
                    console.log(apiKey);
                    console.log(apiSecret);
                    console.log(accessToken);
                    console.log(accessTokenSecret);
                    
                    var oa = new OAuth(apiConfig.oauth.requestURL || null,
                                       apiConfig.oauth.accessURL || null,
                                       apiKey || null,
                                       apiSecret || null,
                                       apiConfig.oauth.version || null,
                                       null,
                                       apiConfig.oauth.crypt);

                    if (config.debug) {
                        console.log('Access token: ' + accessToken);
                        console.log('Access token secret: ' + accessTokenSecret);
                        console.log('key: ' + key);
                    };

                    oa.getProtectedResource(privateReqURL, httpMethod, accessToken, accessTokenSecret,  function (error, data, response) {
                        req.call = privateReqURL;

                        // console.log(util.inspect(response));
                        if (error) {
                            console.log('Got error: ' + util.inspect(error));

                            if (error.data == 'Server Error' || error.data == '') {
                                req.result = 'Server Error';
                            } else {
                                req.result = error.data;
                            }

                            res.statusCode = error.statusCode

                            next();
                        } else {
                            req.resultHeaders = response.headers;
                            req.result = JSON.parse(data);

                            next();
                        }
                    });
                }
            );
        } else if (apiConfig.oauth.type == 'two-legged' && reqQuery.oauth == 'authrequired') { // Two-legged
            if (config.debug) {
                console.log('Two Legged OAuth');
            };

            var body,
                oa = new OAuth(null,
                               null,
                               apiKey || null,
                               apiSecret || null,
                               apiConfig.oauth.version || null,
                               null,
                               apiConfig.oauth.crypt);

            var resource = options.protocol + '://' + options.host + options.path,
                cb = function(error, data, response) {
                    if (error) {
                        if (error.data == 'Server Error' || error.data == '') {
                            req.result = 'Server Error';
                        } else {
                            console.log(util.inspect(error));
                            body = error.data;
                        }

                        res.statusCode = error.statusCode;

                    } else {
                        console.log(util.inspect(data));

                        var responseContentType = response.headers['content-type'];

                        switch (true) {
                            case /application\/javascript/.test(responseContentType):
                            case /text\/javascript/.test(responseContentType):
                            case /application\/json/.test(responseContentType):
                                body = JSON.parse(data);
                                break;
                            case /application\/xml/.test(responseContentType):
                            case /text\/xml/.test(responseContentType):
                            default:
                        }
                    }

                    // Set Headers and Call
                    if (response) {
                        req.resultHeaders = response.headers || 'None';
                    } else {
                        req.resultHeaders = req.resultHeaders || 'None';
                    }

                    req.call = url.parse(options.host + options.path);
                    req.call = url.format(req.call);

                    // Response body
                    req.result = body;
		    req.statusCode = response.statusCode;

                    next();
                };

            switch (httpMethod) {
                case 'GET':
                    console.log(resource);
                    oa.get(resource, '', '',cb);
                    break;
                case 'PUT':
                case 'POST':
                    oa.post(resource, '', '', JSON.stringify(obj), null, cb);
                    break;
                case 'DELETE':
                    oa.delete(resource,'','',cb);
                    break;
            }

        } else {
            // API uses OAuth, but this call doesn't require auth and the user isn't already authed, so just call it.
            unsecuredCall();
        }
    } else {
        // API does not use authentication
        unsecuredCall();
    }

    // Unsecured API Call helper
    function unsecuredCall() {
        console.log('Unsecured Call');

        // Add API Key to params, if any.
        if (apiKey != '' && apiKey != 'undefined' && apiKey != undefined) {
            if (config.debug) {
                console.log('Using API Key: ' + apiKey);
            }
            if (apiConfig.keyMethod == 'basicAuth') {
                // if keyMethod is basic auth, check the keyParam to understand how to fill it out
                if (apiConfig.keyParam == 'user') {
                    // use the api key as the "user" field of basic auth
                    credentials = apiKey + ':';
                }
                else if (apiConfig.keyParam == 'password') {
                    // use the api key as the "password" field of basic auth
                    credentials = ':' + apiKey;
                }
                else {
                    // assume the api key is both user and password. Hopefully the key has a ":" in it.
                    credentials = apiKey
                }
                options.headers['Authorization'] = 'Basic ' + new Buffer(credentials).toString('base64');
            }
            else if (apiConfig.keyMethod == "requestHeader") {
                // if keyMethod is request header, check the keyParam for what the header should be
                options.headers[apiConfig.keyParam] = apiKey
            }
            else {
                // Assume that the keyType is "queryParam" and pass apiKey as a query parameter.
                if (options.path.indexOf('?') !== -1) {
                    options.path += '&';
                }
                else {
                    options.path += '?';
                }
                options.path += apiConfig.keyParam + '=' + apiKey;
            }
        }

        // Perform signature routine, if any.
        if (apiConfig.signature) {
            if (apiConfig.signature.type == 'signed_md5') {
                // Add signature parameter
                var timeStamp = Math.round(new Date().getTime()/1000);
                var sig = crypto.createHash('md5').update('' + apiKey + apiSecret + timeStamp + '').digest(apiConfig.signature.digest);
                options.path += '&' + apiConfig.signature.sigParam + '=' + sig;
            }
            else if (apiConfig.signature.type == 'signed_sha256') { // sha256(key+secret+epoch)
                // Add signature parameter
                var timeStamp = Math.round(new Date().getTime()/1000);
                var sig = crypto.createHash('sha256').update('' + apiKey + apiSecret + timeStamp + '').digest(apiConfig.signature.digest);
                options.path += '&' + apiConfig.signature.sigParam + '=' + sig;
            }
        }

        // Setup headers, if any
        if (reqQuery.headerNames && reqQuery.headerNames.length > 0) {
            if (config.debug) {
                console.log('Setting headers');
            };
            var headers = {};

            for (var x = 0, len = reqQuery.headerNames.length; x < len; x++) {
                if (config.debug) {
                  console.log('Setting header: ' + reqQuery.headerNames[x] + ':' + reqQuery.headerValues[x]);
                };
                if (reqQuery.headerNames[x] != '') {
                    headers[reqQuery.headerNames[x]] = reqQuery.headerValues[x];
                }
            }
            if (options.headers) {
                options.headers += headers;
            } 
            else {
               options.headers = headers;
            }
        }

        if(options.headers === void 0){
            options.headers = {}
        }
        if (!options.headers['Content-Length']) {
            if (content) {
                options.headers['Content-Length'] = content.length;
            }
            else {
                options.headers['Content-Length'] = 0;
            }
        }

        if (!options.headers['Content-Type'] && content) {
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        if (config.debug) {
            console.log(util.inspect(options));
        };

        var doRequest;
        if (options.protocol === 'https' || options.protocol === 'https:') {
            console.log('Protocol: HTTPS');
            options.protocol = 'https:'
            doRequest = https.request;
        } else {
            console.log('Protocol: HTTP');
            doRequest = http.request;
        }
        if(contentType !== ''){
            if (config.debug) {
                console.log('Setting Content-Type: ' + contentType);
            }
            options.headers['Content-Type'] = contentType;
        }

        // update requestHeaders to pass back for display
        req.requestHeaders = options.headers;

        // API Call. response is the response from the API, res is the response we will send back to the user.
        var apiCall = doRequest(options, function(response) {
            response.setEncoding('utf-8');

            if (config.debug) {
                console.log('HEADERS: ' + JSON.stringify(response.headers));
                console.log('STATUS CODE: ' + response.statusCode);
            };

            req.statusCode = response.statusCode;

            var body = '';

            response.on('data', function(data) {
                body += data;
            })

            response.on('end', function() {
                delete options.agent;

                var responseContentType = response.headers['content-type'];

                switch (true) {
                    case /application\/javascript/.test(responseContentType):
                    case /application\/json/.test(responseContentType):
                        console.log(util.inspect(body));
                        // body = JSON.parse(body);
                        break;
                    case /application\/xml/.test(responseContentType):
                    case /text\/xml/.test(responseContentType):
                    default:
                }

                // Set Headers and Call
                req.resultHeaders = response.headers;
                req.call = url.parse(options.host + options.path);
                req.call = url.format(req.call);
                req.statusCode = response.statusCode;

                // Response body
                req.result = body;

                console.log(util.inspect(body));

                next();
            })
        }).on('error', function(e) {
            if (config.debug) {
                console.log('HEADERS: ' + JSON.stringify(res.headers));
                console.log("Got error: " + e.message);
                console.log("Error: " + util.inspect(e));
            };
        });

        if(content !== ''){
            apiCall.write(content,'utf-8');
        }
        apiCall.end();
    }
}

var cachedApiInfo = [];

// Dynamic Helpers
// Passes variables to the view
app.dynamicHelpers({
    session: function(req, res) {
    // If api wasn't passed in as a parameter, check the path to see if it's there
        if (!req.params.api) {
            pathName = req.url.replace('/','');
            // Is it a valid API - if there's a config file we can assume so
            fs.stat(__dirname + '/public/data/' + pathName + '.json', function (error, stats) {
                if (stats) {
                    req.params.api = pathName;
                }
            });
        }       
        // If the cookie says we're authed for this particular API, set the session to authed as well
        if (req.params.api && req.session[req.params.api] && req.session[req.params.api]['authed']) {
            req.session['authed'] = true;
        }

        return req.session;
    },
    apiInfo: function(req, res) {
        if (req.params.api) {
            return apisConfig[req.params.api];
        } else {
            return apisConfig;
        }
    },
    apiName: function(req, res) {
        if (req.params.api) {
            return req.params.api;
        }
    },
    apiDefinition: function(req, res) {
        if (req.params.api) {
            var data = getData(req.params.api);
            processApiIncludes(data, req.params.api);
            cachedApiInfo = data;
            return data;
        }
    }
});

/*
   Can be called in the following ways:
        getData("klout");
        getData("klout", "./klout/get-methods.json");
        getData("klout", "/user/home/klout/klout.json");
        getData("klout", "/user/home/random/nonsense.json");

*/
function getData(api, passedPath) {
    var end = ".json";
    var loc;
    // Error checking
    if ( /[A-Za-z_\-\d]+/.test(api)) {
        //console.log('Valid input for API name.');
    }
    else {
        console.log('API name provided contains invalid characters.');        
    }

    /*
       Check whether api-name given is in apiconfig.
       Check whether api has 'href' property in config.
       If so, check if 'href' property is of 'file' or 'htttp'.
       If 'file', check that 'href' property contains a directory; print warning
        if not a directory
       Check if there was a second argument given (passedPath)
       If passedPath, check whether it is a relative path (should start with './'
        if it is).
       Otherwise, check that the passedPath is of 'file' type and get the data
        from it. Assuming a full path is being given.
       If no passedPath, attempt to return the api-name.json file from the directory
        given in the config file.
       If no 'href' property in given config for given api name, but passedPath
        exists with a relative directory, use default location and attempt to
        return data.
       If no 'href' property and no passedPath, attempt to get api-name.json from
        default location (iodocs installation directory + '/public/data').
       If given api name isn't found in the config file, print statement stating
        as much.
    */

    if (apisConfig.hasOwnProperty(api)) {
        if (apisConfig[api].hasOwnProperty('href')) {
            loc = url.parse(apisConfig[api]['href']);

            if (loc.protocol.match(/^file:$/)) {
                // Need a directory check on loc.path here
                // Not sure if that should be sync or async.
                if (undefined !== passedPath) {
                    if (/^.\//.test(passedPath)) {
                        return require(pathy.resolve(loc.path, passedPath));
                    }
                    else if (url.parse(passedPath).protocol
                            && url.parse(passedPath).protocol.match(/^file:$/)) {
                        return require(passedPath);
                    }
                }
                else {
                    return require(pathy.join(loc.path + api + end));
                }
            }
        }
        else if (/^.\//.test(passedPath)) {
            return require(pathy.resolve(__dirname + '/public/data/' , passedPath));
        }
        else {
            return require(__dirname + '/public/data/' + api + '.json');
        }
    }
    else {
        console.log("'" + api + "' does not exist in config file.");
    }
}

// This function was developed with the assumption that the starting input
// would be the main api file, which would look like the following:
//    { "endpoints":
//        [...]
//    }
//
// The include statement syntax looks like this:
//    {
//        "external":
//        {
//            "href": "./public/data/desired/data.json",
//            "type": "list"
//        }
//    }
// "type": "list" is used only when the contents of the file to be included is a list object 
// that will be merged into an existing list. 
// An example would be storing all the get methods for an endpoint as a list of objects in 
// an external file.
function processApiIncludes (jsonData, apiName) {
    // used to determine object types in a more readable manner
    var what = Object.prototype.toString;
    var includeKeyword = 'external';
    var includeLocation = 'href';

    if (typeof jsonData === "object") {
        for (var key in jsonData) {
            // If an object's property contains an array, go through the objects in the array
            //  Endpoints and Methods are examples of this
            //  Endpoints contains a list of javascript objects, which are easily split into individual files.
            //      Each endpoint is basically a 1 to 1 javascript object relationship
            //  Methods aren't quite as nice.
            //      It could be convenient to split methods into get/put/post/delete externals.
            //      This then creates a 1 to many javascript object relationship
            if (what.call(jsonData[key]) === '[object Array]') {
                var i = jsonData[key].length;

                // Iterating through the array in reverse so that if an element needs to be replaced
                // by multiple elements, the array index does not need to be updated. 
                while (i--) {
                    var arrayObj = jsonData[key][i];
                    if ( includeKeyword in arrayObj ) {
                        var tempArray = getData(apiName, arrayObj[includeKeyword][includeLocation]);
                        // 1 include request to be replaced by multiple objects (methods)
                        if (arrayObj[includeKeyword]['type'] == 'list') {

                            // recurse here to replace values of properties that may need replacing
                            processApiIncludes(tempArray, apiName);
                            // why isn't this jsonData[key][i]?
                            //  Because the array itself is being replaced with an updated version
                            jsonData[key] = mergeExternal(i, jsonData[key], tempArray);

                        }
                        // 1 include request to be replaced by 1 object (endpoint)
                        else {
                            jsonData[key][i] = tempArray;
                            processApiIncludes(jsonData[key][i], apiName);
                        }
                    }
                }
            }

            // If an object's property contains an include statement, this will handle it.
            if (what.call(jsonData[key]) === '[object Object]') {
                for (var property in jsonData[key]) {
                    if (what.call(jsonData[key][property]) === '[object Object]') {
                        if (includeKeyword in jsonData[key][property]) {
                            jsonData[key][property] = getData(apiName, jsonData[key][property][includeKeyword][includeLocation]);
                            processApiIncludes(jsonData[key][property], apiName);
                        }
                    }
                }
            }
        }
    }
}

// Takes the array position of an element in array1, removes that element, 
// and in its place, the contents of array2 are merged in.
function mergeExternal (arrayPos, array1, array2) {
    var a1_tail = array1.splice(arrayPos, array1.length);
    a1_tail.splice(0, 1);
    return array1.concat(array2).concat(a1_tail);
}

// Search function.
// Expects processed API json data and a search term.
// There should be no 'external' link objects present.
function search (jsonData, searchTerm) {
    // From: http://simonwillison.net/2006/Jan/20/escape/#p-6
    var regexFriendly = function(text) {
        return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
    };

    // If ' OR ' is present in the search string, the search term will be split on ' OR ',
    // and the first two parts will be used. These two parts will have spaces 
    // stripped from them and then the regex term will present results that contain
    // matches that have either term.
    //
    // If ' OR ' is not present, the given term will be searched for, spaces will not be 
    // removed from the given term in this case.
    var regex;
    if (/\s+OR\s+/.test(searchTerm)) {
        var terms = searchTerm.split(/\s+OR\s+/);
        terms[0] = regexFriendly(terms[0].replace(/\s+/, ''));
        terms[1] = regexFriendly(terms[1].replace(/\s+/, ''));
        regex = new RegExp ( "("+terms[0]+"|"+terms[1]+")" , "i");
    }
    else {
        var terms = searchTerm.split(/\s+/);
        var regexString = "";
        for (var t = 0; t < terms.length; t++) {
            regexString += "(?=.*" + regexFriendly(terms[t]) + ")";
        }
        regex = new RegExp( regexString, "i" );
    }

    // Get a list of all methods from the data.
    var searchMatches = [];

    // Iterate through endpoints
    for (var i = 0; i < jsonData.endpoints.length; i++) {
        var object = jsonData.endpoints[i];

        // Iterate through methods
        for (var j = 0; j < object.methods.length; j++) {
            if ( filterSearchObject(object.methods[j], regex) ) {
                searchMatches.push({"label":object.methods[j]['MethodName'], "category": object.name, "type":object.methods[j]['HTTPMethod']});
            }
        }
    }

    return searchMatches;
}

// Method searching function
// Recursively check properties of a method object for a match to the given search term.
function filterSearchObject (randomThing, regex) {
    var what = Object.prototype.toString;
    if (what.call(randomThing) === '[object Array]') {
        for (var i = 0; i < randomThing.length; i++) {
            if (filterSearchObject(randomThing[i], regex)) {
                return true;
            }
        }
    }
    else if (what.call(randomThing) === '[object Object]') {
        for (var methodProperty in randomThing) {
            if (randomThing.hasOwnProperty(methodProperty)) {
                if (filterSearchObject(randomThing[methodProperty], regex)) {
                    return true;
                }
            }
        }
    }
    else if (what.call(randomThing) === '[object String]' || what.call(randomThing) === '[object Number]' ) {
        if ( regex.test(randomThing)) {
            return true;
        }
    }
    else {
        return false;
    }

    return false;
}

//
// Routes
//
app.get('/', function(req, res) {
    res.render('listAPIs', {
        title: config.title
    });
});

//
// Search function
//
// Note: If a change is made to app.js, the node process restarted, and the search 
// function  is used immediately without restart, there will be an error coming from the 
// search() function regarding the use of '.length'. Refresh the page, and the error 
// will go away. A page refresh is necessary to create a cached version of the api 
// which this route uses.
//  Not sure what the fix for this is.
app.get('/search', function(req, res) {
    var searchTerm = decodeURIComponent(req.query.term);
    res.send( search(cachedApiInfo, searchTerm) );
});

// Process the API request
app.post('/processReq', oauth, processRequest, function(req, res) {
    var result = {
        request_headers: req.requestHeaders,
        response_headers: req.resultHeaders,
        response: req.result,
        call: req.call,
        code: req.statusCode
    };

    res.send(result);
});

// Just auth
app.all('/auth', oauth);

// OAuth callback page, closes the window immediately after storing access token/secret
app.get('/authSuccess/:api', oauthSuccess, function(req, res) {
    res.render('authSuccess', {
        title: 'OAuth Successful'
    });
});

app.post('/upload', function(req, res) {
  console.log(req.body.user);
  res.redirect('back');
});

// API shortname, all lowercase
app.get('/:api([^\.]+)', function(req, res) {
    req.params.api=req.params.api.replace(/\/$/,'');
    res.render('api');
});

// Only listen on $ node app.js

if (!module.parent) {
    var port = process.env.PORT || config.port;
    var l = app.listen(port);
    l.on('listening', function(err) {
        console.log("Express server listening on port %d", app.address().port);
    });
}
