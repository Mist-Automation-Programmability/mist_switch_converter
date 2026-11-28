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
    httpPort: 3000,
    // Enable HTTPS directly with NodeJS. 
    // Set to false if you are using a reverse proxy to manage HTTPS (nginx, apache, ...)
    enableHttps: true,
    // used if enableHttps = true
    httpsPort: 3443,
    // used if enableHttps = true
    // certificate name. The certificate has to be installed into certs folder
    httpsCertificate: "default.pem",
    // key name. The key has to be installed into certs folder, without password
    httpsKey: "default.key"
}

/******************************************************************************
 *                               START PAGE                                  *
 ******************************************************************************/
module.exports.login = {
    // Text shown under the drop box, for example a warning or a disclaimer.
    // Line breaks are kept. Empty: no text.
    disclaimer: "",
    // Links shown under the drop box. "none" hides a link.
    github_url: "https://github.com/Mist-Automation-Programmability/mist_switch_converter",
    docker_url: "https://hub.docker.com/r/tmunzer/mist_switch_converter"
}
