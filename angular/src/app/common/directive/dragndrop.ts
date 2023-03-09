import { Directive, HostListener, ElementRef } from '@angular/core';

@Directive({
    selector: '[dropContainer]',
})
export class DropContainerDirective {
    el: ElementRef;
    initialBackgroundColor: string;
    constructor(el: ElementRef) {
        this.el = el;
    }

    @HostListener('dragover', ['$event']) onDragOver(evt: any) {
        evt.preventDefault();
        evt.stopPropagation();
        this.el.nativeElement.style.opacity = '.7';
        this.el.nativeElement.style.backgroundColor = '#dddddd';
    }

    @HostListener('dragleave', ['$event']) public onDragLeave(evt: any) {
        evt.preventDefault();
        evt.stopPropagation();
        this.el.nativeElement.style.opacity = '1';
        this.el.nativeElement.style.backgroundColor = 'white';
    }

    @HostListener('drop', ['$event']) public ondrop(evt: any) {
        this.el.nativeElement.style.opacity = '1';
        this.el.nativeElement.style.backgroundColor = 'white';
    }
}
