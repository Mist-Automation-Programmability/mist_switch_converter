const express = require('express');
const morgan = require('morgan');
const path = require('path');;
const logger = require("./logger");
/*================================================================
 LOAD APP SETTINGS
 ================================================================*/
function stringToBool(val, def_val) {
    if (val) {
        val = val.toLowerCase();
        if (val == "true" || val == "1") return true;
        else if (val == "false" || val == "0") return false;
    }
    return def_val
}

var config = {}
try {
    config = require("./config");
    logger.info("Config file found!")
} catch (e) {
    logger.info("No Config file. Using ENV variables!")
    config = {
        appServer: {
            httpPort: process.env.NODE_PORT || 3000,
            enableHttps: stringToBool(process.env.NODE_HTTPS, false),
            httpsPort: process.env.NODE_PORT_HTTPS || 3443,
            httpsCertificate: process.env.NODE_HTTPS_CERT || null,
            httpsKey: process.env.NODE_HTTPS_KEY || null,
        },
        login: {
            disclaimer: process.env.APP_DISCLAIMER || "",
            github_url: process.env.APP_GITHUB_URL || "",
            docker_url: process.env.APP_DOCKER_URL || ""
        }
    }
} finally {
    logger.info("Config loaded!")
    global.config = config;
}

global.appPath = path.dirname(require.main.filename).replace(new RegExp('/bin$'), "");

/*================================================================
 EXPRESS
 ================================================================*/
var app = express();
// remove http header
app.disable('x-powered-by');
// log http request
//using the logger and its configured transports, to save the logs created by Morgan
const myStream = {
    write: (text) => {
        logger.info(text);
    }
}
app.use(morgan('combined', { stream: myStream }));
// app.use(morgan('\x1b[32minfo\x1b[0m: :remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length]', {
//     skip: function(req, res) { return res.statusCode < 400 && req.originalUrl != "/"; }
// }));

/*================================================================
 APP - SERVER ROLE
 ================================================================*/
logger.info("Starting SERVER_MODE");
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

//================ROUTES=================
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');
app.use(express.static(__dirname + '/public'));

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
//app.use('/bower_components', express.static('../bower_components'));


//===============ROUTES=================
// // User Interface    
const main = require('./routes/main');
app.use('/', main);
const api = require('./routes/api');
app.use('/api/', api);

//Otherwise
app.get("*", function(req, res) {
    res.redirect("/");
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.redirect('error', {
            message: err.message,
            stack: err
        });
        logger.error(err);
    });
} else {
    // production error handler
    // no stacktraces leaked to user
    app.use(function(err, req, res, next) {
        if (err.status == 404) res.redirect('/unknown');
        res.status(err.status || 500);
        res.redirect('/error');
    });
}

module.exports = app;