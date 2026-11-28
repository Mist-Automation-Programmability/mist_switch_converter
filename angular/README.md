# SwitchConfigConverter

This project uses [Angular](https://angular.dev) 22 and its CLI. It needs Node.js 22.22.3 or later (24.15 or later on Node.js 24).

## Development server

Run `ng serve` for a dev server. Navigate to `http://localhost:4200/`. The app will automatically reload if you change any of the source files.

## Code scaffolding

Run `ng generate component component-name` to generate a new component. You can also use `ng generate directive|pipe|service|class|guard|interface|enum|module`.

## Build

Run `ng build` to build the project. The build artifacts will be stored in the `dist/` directory.

## Running unit tests

Run `npm test` to execute the unit tests of the converter with [Vitest](https://vitest.dev). They run in Node, without a browser, in about a second.

- `npm run test:watch` reruns the tests on every change.
- `npm run test:defects` shows how each known defect fails.
- `npm run test:types` type-checks the converter and its tests.

The tests, the list of known defects and the rules for test data are described in [src/app/converters/__tests__/README.md](src/app/converters/__tests__/README.md).

## Running end-to-end tests

Run `ng e2e` to execute the end-to-end tests via a platform of your choice. To use this command, you need to first add a package that implements end-to-end testing capabilities.

## Further help

To get more help on the Angular CLI use `ng help` or go check out the [Angular CLI Overview and Command Reference](https://angular.io/cli) page.
