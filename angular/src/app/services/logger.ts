import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface LogMessage {
    level: string,
    file:string,
    message: string
}

@Injectable({
    providedIn: 'root'
})
export class Logger {
    // Observable string sources
    private logMessages: LogMessage[] = []
    private logSource = new Subject<LogMessage>();

    // Observable string streams
    logs = this.logSource.asObservable();

    constructor() { }

    // Service message commands
    debug(message: string, file:string="") {
        this.addEvent("debug", message, file);
    }
    info(message: string, file:string="") {
        //console.info(message);
        this.addEvent("info", message, file);
    }
    warning(message: string, file:string="") {
        //console.warn(message);
        this.addEvent("warning", message, file);
    }
    error(message: string, file:string="") {
        //console.error(message);
        this.addEvent("error", message, file);
    }
    critical(message: string, file:string="") {
        this.addEvent("critical", message, file);
    }

    private addEvent(level: string, message: string, file:string) {
        const new_event: LogMessage = {
            level: level,
            file: file,
            message: message
        };
        this.logMessages.push(new_event);
        this.logSource.next(new_event);
    }

    getall(): LogMessage[] {
        return this.logMessages;
    }

}