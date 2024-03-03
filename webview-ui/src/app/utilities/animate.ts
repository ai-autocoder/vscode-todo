import {
	AfterViewInit,
	Directive,
	ElementRef,
	Input,
	OnChanges,
	SimpleChanges,
} from "@angular/core";
import autoAnimate, {
	AutoAnimateOptions,
	AutoAnimationPlugin,
	getTransitionSizes,
} from "@formkit/auto-animate";

interface KeyframeWithSize extends Keyframe {
	width?: string;
	height?: string;
}

@Directive({
	selector: "[auto-animate]",
})
export class AutoAnimateDirective implements AfterViewInit, OnChanges {
	@Input() options: Partial<AutoAnimateOptions> | AutoAnimationPlugin = {};

	constructor(private el: ElementRef) {}

	ngAfterViewInit(): void {
		// Initialize auto-animate with the initial options
		this.applyAutoAnimate();
	}

	ngOnChanges(changes: SimpleChanges): void {
		// Apply auto-animate with the new options when they change
		if (changes["options"]) {
			this.applyAutoAnimate();
		}
	}

	private applyAutoAnimate(): void {
		// Apply auto-animate to the element with the current options
		// autoAnimate(this.el.nativeElement, this.options);
		autoAnimate(this.el.nativeElement, (el, action, oldCoords, newCoords) => {
			let keyframes: KeyframeWithSize[] = [];
			const animationOptions = this.options as AutoAnimateOptions;
			const containerHeight = el.parentElement?.offsetHeight || 0;
			// supply a different set of keyframes for each action
			if (action === "add") {
				keyframes = [
					{ transform: `translateY(calc(${containerHeight}px - 101%))`, background: "grey" },
					{ transform: "translateY(0px)" },
				];
			}
			// keyframes can have as many "steps" as you prefer
			// and you can use the 'offset' key to tune the timing
			if (action === "remove") {
				keyframes = [
					{ transform: "scale(1)", opacity: 1 },
					{ transform: "scale(1.15)", opacity: 1, offset: 0.33 },
					{ transform: "scale(0.75)", opacity: 0.1, offset: 0.5 },
					{ transform: "scale(0.5)", opacity: 0 },
				];
			}
			if (action === "remain" && oldCoords && newCoords) {
				// for items that remain, calculate the delta
				// from their old position to their new position
				const deltaX = oldCoords.left - newCoords.left;
				const deltaY = oldCoords.top - newCoords.top;
				// use the getTransitionSizes() helper function to
				// get the old and new widths of the elements
				const [widthFrom, widthTo, heightFrom, heightTo] = getTransitionSizes(el, oldCoords, newCoords);
				// set up our steps with our positioning keyframes
				const start: KeyframeWithSize = { transform: `translate(${deltaX}px, ${deltaY}px)` };
				const end: KeyframeWithSize = { transform: `translate(0, 0)` };
				// if the dimensions changed, animate them too.
				if (widthFrom !== widthTo) {
					start.width = `${widthFrom}px`;
					end.width = `${widthTo}px`;
				}
				if (heightFrom !== heightTo) {
					start.height = `${heightFrom}px`;
					end.height = `${heightTo}px`;
				}
				keyframes = [start, end];
			}
			// return our KeyframeEffect() and pass
			// it the chosen keyframes.
			return new KeyframeEffect(el, keyframes, {
				duration: animationOptions.duration,
				easing: animationOptions.easing || "ease-out",
			});
		});
	}
}
