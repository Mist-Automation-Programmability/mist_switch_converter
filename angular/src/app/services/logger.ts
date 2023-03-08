import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface LogMessage {
    level: string,
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
    debug(message: string) {
        this.addEvent("debug", message);
    }
    info(message: string) {
        this.addEvent("info", message);
    }
    warning(message: string) {
        this.addEvent("warning", message);
    }
    error(message: string) {
        this.addEvent("error", message);
    }
    critical(message: string) {
        this.addEvent("critical", message);
    }

    private addEvent(level: string, message: string) {
        const new_event: LogMessage = {
            level: level,
            message: message
        };
        this.logMessages.push(new_event);
        this.logSource.next(new_event);
    }

    getall(): LogMessage[] {
        return this.logMessages;
    }

}