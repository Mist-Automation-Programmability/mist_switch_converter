# Mist Switch Converter

## MIT LICENSE
 
Copyright (c) 2023 Thomas Munzer

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the  Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## Features
This app can be used to convert Cisco IOS, Junos and Aruba AOS-CX configuration file(s) into a single Mist switch template. All the configuration elements are not migrated, but this app takes care of the main configuration parts:
- NTP Servers
- DNS Server
- DNS Domain
- RADIUS Authentication and Accounting Servers
- TACACS+ Servers
- Syslog Servers
- VLANs
- DHCP Snooping
- Port profiles based on the switch ports configuration
- CLI Banner


<img src="https://github.com/tmunzer/mist_switch_converter/raw/main/._readme/img/landing.png"  width="50%"  />
<img src="https://github.com/tmunzer/mist_switch_converter/raw/main/._readme/img/config.png"  width="50%"  />


## How it's working
* This application is not sending any information to a server, all the process is directly done into the web browser
* This application is parsing one or multiple configuration files to retrieve the configuration elements, convert them into Mist language, and create a Mist switch template. This template can be downloaded, then uploaded in the Mist Organization.
* This application is not able to retrieve the passwords or the secrets (RADIUS, TACACS+, ...). These parameters MUST be reconfigured from the Mist dashboard.
* The port profile names re generated from the interface description in the configuration. If the same configuration is detected multiple times but with different descriptions, the app will generate a new name based on the most recurrent words in the descriptions.

## Tests

The conversion code has unit tests that run in Node:

```sh
cd angular
npm ci
npm test
```

See [angular/src/app/converters/__tests__/README.md](angular/src/app/converters/__tests__/README.md) for what they cover, the list of known defects, and the rules for test data. Test data is synthetic: never add a customer configuration to this repository.

The conversion code itself, and how to add a command or a vendor, is described in [angular/src/app/converters/README.md](angular/src/app/converters/README.md).

## Installation

This app can be run as a standalone Node application, or can be deployed as a Docker container.

**Note**: The application is not providing secured HTTPS connections. It is highly recommended to deploy it behind a reverse proxy providing HTTPS encryption.

### Standalone deployment
1. download the github repository
2. from the project folder, go to the `src` folder and install the python dependencies with `npm install`
3. start the node server with `npm start`. This will start the server with the default parameters (HTTP only, server listening on TCP3000)

It is possible to change the server parameters by creating a configuration file, or setting environment variables (see below).

To use the configuration file, copy the file `src/config_example.js` to `src/config.js`. Edit the file to match your requirements, then start the server with `npm start` from the `src` folder.

### Docker Image
The docker image is available on docker hub: https://hub.docker.com/r/tmunzer/mist_switch_converter


The Docket image is listening on port TCP3000

## Configuration
You can configure the settings through a configuration file or through Environment Variables.

### Environment Variables
| Variable Name | Type | Default Value | Comment |
| ------------- | ---- | ------------- | ------- |
NODE_PORT | Number | 3000 | TCP Port on which Node will listen for HTTP Requests |
NODE_HTTPS | Boolean | false | Wether or not to enable HTTPS. if set to `true`, `NODE_HTTPS_CERT` and `NODE_HTTPS_KEY` are required |
NODE_PORT_HTTPS | Number | 3443 | TCP Port on which Node will listen for HTTPS Requests |
NODE_HTTPS_CERT | String | | HTTPS certificate | 
NODE_HTTPS_KEY | String | | HTTPS key | 
APP_DISCLAIMER | String | | Text shown under the drop box of the start page, for example a warning or a disclaimer. Line breaks are kept |
APP_GITHUB_URL | String | link to this repository | GitHub link shown under the drop box. `none` hides it |
APP_DOCKER_URL | String | link to the Docker Hub image | Docker link shown under the drop box. `none` hides it |

