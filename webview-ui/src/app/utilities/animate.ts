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
    standalone: false
})
export class AutoAnimateDirective implements AfterViewInit, OnChanges {
	@Input() autoAnimateOptions: Partial<AutoAnimateOptions> | AutoAnimationPlugin = {};
	@Input() autoAnimateEnabled = false;
	private animationController!: ReturnType<typeof autoAnimate>;

	constructor(private el: ElementRef) {}

	ngAfterViewInit(): void {
		this.applyAutoAnimate();
		if (!this.autoAnimateEnabled) {
			this.disableAnimation();
		}
	}

	ngOnChanges(changes: SimpleChanges): void {
		// Apply auto-animate with the new options when they change
		if (changes["autoAnimateOptions"] && this.autoAnimateEnabled) {
			this.applyAutoAnimate();
		}
		if (changes["autoAnimateEnabled"]) {
			changes["autoAnimateEnabled"].currentValue ? this.enableAnimation() : this.disableAnimation();
		}
	}
	private enableAnimation() {
		if (this.animationController) {
			this.animationController.enable();
		}
	}
	private disableAnimation() {
		if (this.animationController) {
			this.animationController.disable();
		}
	}

	private applyAutoAnimate(): void {
		// Apply auto-animate with default animation keyframes
		// this.animationController = autoAnimate(this.el.nativeElement, this.options);

		// Or use custom animation keyframes (comment out the above and uncomment the below)
		this.animationController = autoAnimate(
			this.el.nativeElement,
			(el, action, oldCoords, newCoords) => {
				let keyframes: KeyframeWithSize[] = [];
				const animationOptions = this.autoAnimateOptions as AutoAnimateOptions;
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
					keyframes = [{}];
				}
				if (action === "remain" && oldCoords && newCoords) {
					// for items that remain, calculate the delta
					// from their old position to their new position
					const deltaX = oldCoords.left - newCoords.left;
					const deltaY = oldCoords.top - newCoords.top;
					// use the getTransitionSizes() helper function to
					// get the old and new widths of the elements
					const [widthFrom, widthTo, heightFrom, heightTo] = getTransitionSizes(
						el,
						oldCoords,
						newCoords
					);
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
			}
		);
	}
}
