FROM node:lts-alpine
LABEL fr.mist-lab.converter.version="0.0.1"
LABEL fr.mist-lab.converter.release-date="2023-03-06"

COPY ./src /app/

WORKDIR /app

RUN npm	install

EXPOSE 3000
ENTRYPOINT [ "npm", "start" ]


