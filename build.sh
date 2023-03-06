#!/bin/bash


cd angular
ng build --deploy-url /ng/ 
rm -rf ../src/public/ng/*
cp -r ./dist/mist_switch_migration/* ../src/public/ng
cp ./dist/mist_switch_migration/index.html ../src/views/index.html
