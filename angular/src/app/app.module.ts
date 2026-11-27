import { NgModule, provideZoneChangeDetection } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { provideHttpClient, withInterceptorsFromDi, withXhr } from '@angular/common/http';

import { AppComponent } from './app.component';
import { FileViewComponent } from './workbench/file-view.component';
import { HowItWorksComponent } from './workbench/how-it-works.component';
import { JsonViewComponent } from './workbench/json-view.component';
import { LogsViewComponent } from './workbench/logs-view.component';
import { PartViewComponent } from './workbench/part-view.component';

@NgModule({
  declarations: [AppComponent],
  imports: [BrowserModule, FormsModule, JsonViewComponent, PartViewComponent, FileViewComponent, LogsViewComponent, HowItWorksComponent],
  providers: [
    // Since Angular 21 an application has no zone.js change detection unless it asks for it
    provideZoneChangeDetection(),
    provideHttpClient(withXhr(), withInterceptorsFromDi()),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
