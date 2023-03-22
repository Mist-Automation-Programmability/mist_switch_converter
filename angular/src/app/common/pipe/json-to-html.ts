import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'jsonToHtml' })
export class JsonToHtml implements PipeTransform {
    transform(data: any, indent: number = 4): string {
        if (!data || Object.keys(data).length == 0) return "<div></div>";
        else if (Array.isArray(data)) return this.isArray("", 0, data, true, indent);
        else return this.isObject("", 0, data, true, indent);
    }

    private isArray(key: string, inc: number, data: any[], is_last: boolean, indent: number): string {
        if (data.length == 0) var html = "<div>" + this.isKey(key, inc, indent) + "[ ]";
        else {
            var html = "<div>" + this.isKey(key, inc, indent) + "[</div>"
            data.forEach((value, idx) => {
                var last = true;
                if (idx < data.length - 1) last = false;
                if (value == null) html += this.isNull(key, inc + 1, last, indent);
                else if (typeof (value) == "string") html += this.isString("", inc + 1, value, last, indent);
                else if (typeof (value) == "number") html += this.isNumber("", inc + 1, value, last, indent);
                else if (typeof (value) == "boolean") html += this.isBoolean("", inc + 1, value, last, indent);
                else if (Array.isArray(value)) html += this.isArray("", inc + 1, value, last, indent);
                else html += this.isObject("", inc + 1, value, last, indent);
            })
            html += "<div>" + " ".repeat(inc * indent) + "]"
        }  
        if (!is_last) html += ","
        html += "</div>"
        return html;
    }
    private isObject(key: string, inc: number, data: Object, is_last: boolean, indent: number): string {

        const length = Object.keys(data).length;
        if (length == 0) var html = "<div>" + this.isKey(key, inc, indent) + "{ }";
        else {
            var i = 0;
            var html = "<div>" + this.isKey(key, inc, indent) + "{</div>"
            for (const key in data) {
                i += 1;
                var last = true;
                if (i < length) last = false;
                const value = (data as any)[key];
                if (value == null) html += this.isNull(key, inc + 1, last, indent);
                else if (typeof (value) == "string") html += this.isString(key, inc + 1, value, last, indent);
                else if (typeof (value) == "number") html += this.isNumber(key, inc + 1, value, last, indent), indent;
                else if (typeof (value) == "boolean") html += this.isBoolean(key, inc + 1, value, last, indent);
                else if (Array.isArray(value)) html += this.isArray(key, inc + 1, value, last, indent);
                else html += this.isObject(key, inc + 1, value, last, indent);
            }
            html += "<div>" + " ".repeat(inc * indent) + "}"
        }
        if (!is_last) html += ","
        html += "</div>"
        return html
    }

    private isString(key: string, inc: number, value: string, is_last: boolean, indent: number): string {

        var html = "<div>" + this.isKey(key, inc, indent) + "<span class='string'>\"" + value.replace(/"/gi, '\\"') + "\"</span>";
        if (!is_last) html += ","
        html += "</div>"
        return html
    }
    private isNumber(key: string, inc: number, value: number, is_last: boolean, indent: number): string {
        var html = "<div>" + this.isKey(key, inc, indent) + "<span class='number'>" + value + "</span>";
        if (!is_last) html += ","
        html += "</div>"
        return html
    }
    private isBoolean(key: string, inc: number, value: boolean, is_last: boolean, indent: number): string {
        var html = "<div>" + this.isKey(key, inc, indent) + "<span class='boolean'>" + value + "</span>";
        if (!is_last) html += ","
        html += "</div>"
        return html
    }
    private isKey(key: string, inc: number = 0, indent: number): string {
        if (key == "") return "<span class='key'>" + " ".repeat(inc * indent) + "</span>"
        else return "<span class='key'>" + " ".repeat(inc * indent) + "\"" + key + "\"</span><span>: </span>"
    }

    // private isEmptyObj(key: string, inc: number = 0, is_last: boolean, indent: number): string {
    //     var html =  "<div>" + this.isKey(key, inc, indent) + "<span>{}</span>";
    //     if (!is_last) html += ","
    //     html += "</div>"
    //     return html
    // }
    private isNull(key: string, inc: number = 0, is_last: boolean, indent: number): string {
        var html = "<div>" + this.isKey(key, inc, indent) + "<span class='null'>null</span>";
        if (!is_last) html += ","
        html += "</div>"
        return html
    }


}

