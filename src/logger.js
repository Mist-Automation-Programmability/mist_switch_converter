const winston = require('winston');


const logConfiguration = {
    levels: winston.config.syslog.levels,
    transports: [
        new winston.transports.Console({ colorize: true })
    ],
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({
            format: 'DD/MM/YY HH:mm:ss'
        }),
        winston.format.printf(info => `${[info.timestamp]} - ${info.level}: ${info.message}`),
    )
};

module.exports = winston.createLogger(logConfiguration);