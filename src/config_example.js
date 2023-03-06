/******************************************************************************
 *                                 NOTES                                    *
 *
 *      This file is an example
 *      Please move this file config_example.js to config.js
 *      and chage the values to match your configuration
 *
 ******************************************************************************/

/******************************************************************************
 *                                 SERVER                                    *
 ******************************************************************************/
module.exports.appServer = {
    vhost: "localhost",
    // Enable HTTPS directly with NodeJS. 
    // Set to false if you are using a reverse proxy to manage HTTPS (nginx, apache, ...)
    enableHttps: true,
    // used if enableHttps = true
    // certificate name. The certificate has to be installed into certs folder
    httpsCertificate: "default.pem",
    // key name. The key has to be installed into certs folder, without password
    httpsKey: "default.key",
    // optional. Used to disable on function of the app to deploy one server to sync rogues and one serer to serve HTTP pages
    disable_server_role: false,
    disable_sync_role: false
}