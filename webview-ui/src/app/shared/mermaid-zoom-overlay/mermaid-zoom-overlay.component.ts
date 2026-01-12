import {
	ChangeDetectionStrategy,
	Component,
	CUSTOM_ELEMENTS_SCHEMA,
	ElementRef,
	EventEmitter,
	Input,
	OnDestroy,
	OnInit,
	Output,
	Renderer2,
	ViewChild,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { IconComponent } from "../icon/icon.component";

@Component({
	selector: "mermaid-zoom-overlay",
	templateUrl: "./mermaid-zoom-overlay.component.html",
	styleUrls: ["./mermaid-zoom-overlay.component.scss"],
	standalone: true,
	imports: [FormsModule, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush,
	schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MermaidZoomOverlayComponent implements OnInit, OnDestroy {
	@Input()
	set svgSource(value: SVGSVGElement | undefined) {
		if (!value) {
			this.resetSvgState();
			return;
		}
		this.prepareSvgFromSource(value);
	}

	@Output() closed = new EventEmitter<void>();

	@ViewChild("diagramZoomStage") diagramZoomStage?: ElementRef<HTMLElement>;
	@ViewChild("diagramZoomCanvas")
	set diagramZoomCanvasRef(value: ElementRef<HTMLDivElement> | undefined) {
		this.diagramZoomCanvas = value;
		if (value && this.zoomSvg) {
			this.renderZoomSvg();
		}
	}

	private diagramZoomCanvas?: ElementRef<HTMLDivElement>;

	diagramZoomScale = 1;
	diagramZoomPanX = 0;
	diagramZoomPanY = 0;
	zoomPanning = false;
	zoomInputValue = "100";

	private zoomMoveUnlistener?: () => void;
	private zoomUpUnlistener?: () => void;
	private zoomCancelUnlistener?: () => void;
	private zoomKeyUnlistener?: () => void;
	private zoomStartX = 0;
	private zoomStartY = 0;
	private zoomStartPanX = 0;
	private zoomStartPanY = 0;
	private zoomPointerId: number | null = null;
	private zoomPointerTarget?: HTMLElement;
	private zoomSvg?: SVGSVGElement;
	private zoomSvgElement?: SVGSVGElement;
	private zoomSvgViewBox?: { x: number; y: number; width: number; height: number };
	private zoomSvgWidth = 0;
	private zoomSvgHeight = 0;
	private panRafId: number | null = null;
	private previousBodyOverflow: string | null = null;
	private readonly zoomFactor = 1.1;
	private readonly zoomMin = 0.1;
	private readonly zoomMax = 100;

	constructor(private renderer: Renderer2) {}

	ngOnInit(): void {
		this.lockBodyScroll();
		this.attachZoomKeyListener();
	}

	ngOnDestroy(): void {
		this.stopZoomPan();
		this.detachZoomKeyListener();
		this.restoreBodyScroll();
		this.resetSvgState();
	}

	get diagramZoomTransform(): string {
		return `translate3d(${this.diagramZoomPanX}px, ${this.diagramZoomPanY}px, 0)`;
	}

	zoomIn(event?: MouseEvent): void {
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}
		const anchor = this.getStageCenterAnchor();
		this.applyZoom(this.diagramZoomScale * this.zoomFactor, anchor);
	}

	zoomOut(event?: MouseEvent): void {
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}
		const anchor = this.getStageCenterAnchor();
		this.applyZoom(this.diagramZoomScale / this.zoomFactor, anchor);
	}

	resetZoom(event?: MouseEvent): void {
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}
		this.diagramZoomScale = 1;
		this.diagramZoomPanX = 0;
		this.diagramZoomPanY = 0;
		this.applyZoomToSvg();
		this.updateZoomTransformStyle();
		this.syncZoomInputValue();
	}

	close(event?: MouseEvent): void {
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}
		this.closed.emit();
	}

	startZoomPan(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === "function") {
			event.stopImmediatePropagation();
		}
		this.zoomPanning = true;
		this.zoomStartX = event.clientX;
		this.zoomStartY = event.clientY;
		this.zoomStartPanX = this.diagramZoomPanX;
		this.zoomStartPanY = this.diagramZoomPanY;
		this.zoomMoveUnlistener?.();
		this.zoomUpUnlistener?.();
		this.zoomCancelUnlistener?.();
		const target = event.currentTarget as HTMLElement | null;
		if (target && typeof event.pointerId === "number") {
			this.zoomPointerId = event.pointerId;
			this.zoomPointerTarget = target;
			target.setPointerCapture(event.pointerId);
		}
		const listenTarget = target ?? "document";
		this.zoomMoveUnlistener = this.renderer.listen(
			listenTarget,
			"pointermove",
			(moveEvent: PointerEvent) => {
				this.onZoomPanMove(moveEvent);
			}
		);
		this.zoomUpUnlistener = this.renderer.listen(listenTarget, "pointerup", (upEvent: PointerEvent) => {
			this.stopZoomPan(upEvent);
		});
		this.zoomCancelUnlistener = this.renderer.listen(
			listenTarget,
			"pointercancel",
			(cancelEvent: PointerEvent) => {
				this.stopZoomPan(cancelEvent);
			}
		);
	}

	commitZoomInput(): void {
		const nextValue = this.parseZoomInput(this.zoomInputValue);
		if (nextValue === null) {
			this.syncZoomInputValue();
			return;
		}
		const anchor = this.getStageCenterAnchor();
		this.applyZoom(nextValue / 100, anchor);
	}

	onZoomInputKeydown(event: KeyboardEvent): void {
		if (event.key === "Enter") {
			event.preventDefault();
			this.commitZoomInput();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.syncZoomInputValue();
			(event.target as HTMLInputElement | null)?.blur();
		}
	}

	onZoomWheel(event: WheelEvent): void {
		if (!event.ctrlKey) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const direction = Math.sign(event.deltaY);
		const anchor = this.getStageAnchorFromEvent(event);
		if (direction < 0) {
			this.applyZoom(this.diagramZoomScale * this.zoomFactor, anchor);
			return;
		}
		if (direction > 0) {
			this.applyZoom(this.diagramZoomScale / this.zoomFactor, anchor);
		}
	}

	stopOverlayMouse(event: MouseEvent): void {
		const target = event.target as HTMLElement | null;
		const isFocusableTarget =
			!!target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable);
		if (!isFocusableTarget || event.type === "dragstart") {
			event.preventDefault();
		}
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === "function") {
			event.stopImmediatePropagation();
		}
	}

	private prepareSvgFromSource(source: SVGSVGElement): void {
		this.zoomSvg = source.cloneNode(true) as SVGSVGElement;
		const rect = source.getBoundingClientRect();
		const attrWidth = this.parseSvgSize(source.getAttribute("width"));
		const attrHeight = this.parseSvgSize(source.getAttribute("height"));
		const viewBox = source.viewBox?.baseVal;
		this.zoomSvgWidth = rect.width || attrWidth || viewBox?.width || 0;
		this.zoomSvgHeight = rect.height || attrHeight || viewBox?.height || 0;
		if (viewBox && viewBox.width && viewBox.height) {
			this.zoomSvgViewBox = {
				x: viewBox.x,
				y: viewBox.y,
				width: viewBox.width,
				height: viewBox.height,
			};
		} else if (this.zoomSvgWidth > 0 && this.zoomSvgHeight > 0) {
			this.zoomSvgViewBox = {
				x: 0,
				y: 0,
				width: this.zoomSvgWidth,
				height: this.zoomSvgHeight,
			};
		} else {
			this.zoomSvgViewBox = undefined;
		}
		this.diagramZoomScale = 1;
		this.diagramZoomPanX = 0;
		this.diagramZoomPanY = 0;
		this.syncZoomInputValue();
		if (this.diagramZoomCanvas) {
			this.renderZoomSvg();
		}
	}

	private renderZoomSvg(): void {
		const canvas = this.diagramZoomCanvas?.nativeElement;
		if (!canvas || !this.zoomSvg) {
			return;
		}
		this.renderer.setProperty(canvas, "innerHTML", "");
		const svg = this.zoomSvg.cloneNode(true) as SVGSVGElement;
		if (this.zoomSvgViewBox) {
			svg.setAttribute(
				"viewBox",
				`${this.zoomSvgViewBox.x} ${this.zoomSvgViewBox.y} ${this.zoomSvgViewBox.width} ${this.zoomSvgViewBox.height}`
			);
		}
		if (this.zoomSvgWidth > 0) {
			svg.setAttribute("width", `${this.zoomSvgWidth}`);
			svg.style.width = `${this.zoomSvgWidth}px`;
		}
		if (this.zoomSvgHeight > 0) {
			svg.setAttribute("height", `${this.zoomSvgHeight}`);
			svg.style.height = `${this.zoomSvgHeight}px`;
		}
		svg.style.maxWidth = "none";
		svg.style.maxHeight = "none";
		svg.style.display = "block";
		this.zoomSvgElement = svg;
		canvas.appendChild(svg);
		this.applyZoomToSvg();
		this.updateZoomTransformStyle();
	}

	private onZoomPanMove(event: PointerEvent): void {
		if (this.zoomPointerId !== null && event.pointerId !== this.zoomPointerId) {
			return;
		}
		if (!this.zoomPanning) {
			return;
		}
		this.diagramZoomPanX = this.zoomStartPanX + (event.clientX - this.zoomStartX);
		this.diagramZoomPanY = this.zoomStartPanY + (event.clientY - this.zoomStartY);
		this.schedulePanUpdate();
	}

	private stopZoomPan(event?: PointerEvent): void {
		this.zoomPanning = false;
		if (this.zoomPointerTarget && this.zoomPointerId !== null) {
			try {
				this.zoomPointerTarget.releasePointerCapture(this.zoomPointerId);
			} catch {
				// ignore capture release failures
			}
		}
		this.zoomPointerId = null;
		this.zoomPointerTarget = undefined;
		if (this.panRafId !== null) {
			cancelAnimationFrame(this.panRafId);
			this.panRafId = null;
			this.updateZoomTransformStyle();
		}
		if (this.zoomMoveUnlistener) {
			this.zoomMoveUnlistener();
			this.zoomMoveUnlistener = undefined;
		}
		if (this.zoomUpUnlistener) {
			this.zoomUpUnlistener();
			this.zoomUpUnlistener = undefined;
		}
		if (this.zoomCancelUnlistener) {
			this.zoomCancelUnlistener();
			this.zoomCancelUnlistener = undefined;
		}
	}

	private applyZoom(nextZoom: number, anchor: { x: number; y: number }): void {
		const clamped = Math.min(this.zoomMax, Math.max(this.zoomMin, nextZoom));
		if (clamped === this.diagramZoomScale) {
			this.syncZoomInputValue();
			return;
		}
		const currentScale = this.diagramZoomScale;
		const scaleRatio = clamped / currentScale;
		const currentOffset = this.getStageOffsetForScale(currentScale);
		const nextOffset = this.getStageOffsetForScale(clamped);
		this.diagramZoomPanX =
			scaleRatio * this.diagramZoomPanX +
			(1 - scaleRatio) * anchor.x +
			scaleRatio * currentOffset.x -
			nextOffset.x;
		this.diagramZoomPanY =
			scaleRatio * this.diagramZoomPanY +
			(1 - scaleRatio) * anchor.y +
			scaleRatio * currentOffset.y -
			nextOffset.y;
		this.diagramZoomScale = Number(clamped.toFixed(2));
		this.applyZoomToSvg();
		this.updateZoomTransformStyle();
		this.syncZoomInputValue();
	}

	private applyZoomToSvg(): void {
		const svg = this.zoomSvgElement;
		if (!svg) {
			return;
		}
		if (this.zoomSvgWidth > 0) {
			const width = this.zoomSvgWidth * this.diagramZoomScale;
			svg.setAttribute("width", `${width}`);
			svg.style.width = `${width}px`;
		}
		if (this.zoomSvgHeight > 0) {
			const height = this.zoomSvgHeight * this.diagramZoomScale;
			svg.setAttribute("height", `${height}`);
			svg.style.height = `${height}px`;
		}
	}

	private updateZoomTransformStyle(): void {
		const canvas = this.diagramZoomCanvas?.nativeElement;
		if (!canvas) {
			return;
		}
		this.renderer.setStyle(canvas, "transform", this.diagramZoomTransform);
	}

	private schedulePanUpdate(): void {
		if (this.panRafId !== null) {
			return;
		}
		this.panRafId = requestAnimationFrame(() => {
			this.panRafId = null;
			this.updateZoomTransformStyle();
		});
	}

	private getStageCenterAnchor(): { x: number; y: number } {
		const rect = this.getStageRect();
		if (!rect) {
			return { x: 0, y: 0 };
		}
		return { x: rect.width / 2, y: rect.height / 2 };
	}

	private getStageAnchorFromEvent(event: MouseEvent | WheelEvent): { x: number; y: number } {
		const rect = this.getStageRect();
		if (!rect) {
			return { x: 0, y: 0 };
		}
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	private getStageRect(): DOMRect | null {
		return this.diagramZoomStage?.nativeElement.getBoundingClientRect() ?? null;
	}

	private getStageOffsetForScale(scale: number): { x: number; y: number } {
		const rect = this.getStageRect();
		if (!rect || this.zoomSvgWidth <= 0 || this.zoomSvgHeight <= 0) {
			return { x: 0, y: 0 };
		}
		return {
			x: (rect.width - this.zoomSvgWidth * scale) / 2,
			y: (rect.height - this.zoomSvgHeight * scale) / 2,
		};
	}

	private syncZoomInputValue(): void {
		this.zoomInputValue = `${Math.round(this.diagramZoomScale * 100)}`;
	}

	private parseZoomInput(value: string): number | null {
		const cleaned = value.replace("%", "").trim();
		const parsed = Number.parseFloat(cleaned);
		if (!Number.isFinite(parsed)) {
			return null;
		}
		return parsed;
	}

	private parseSvgSize(value: string | null): number {
		if (!value) {
			return 0;
		}
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	private resetSvgState(): void {
		this.zoomSvg = undefined;
		this.zoomSvgElement = undefined;
		this.zoomSvgViewBox = undefined;
		this.zoomSvgWidth = 0;
		this.zoomSvgHeight = 0;
	}

	private lockBodyScroll(): void {
		if (this.previousBodyOverflow === null) {
			this.previousBodyOverflow = document.body.style.overflow || "";
		}
		document.body.style.overflow = "hidden";
	}

	private restoreBodyScroll(): void {
		if (this.previousBodyOverflow !== null) {
			document.body.style.overflow = this.previousBodyOverflow;
			this.previousBodyOverflow = null;
		}
	}

	private attachZoomKeyListener(): void {
		this.detachZoomKeyListener();
		this.zoomKeyUnlistener = this.renderer.listen("document", "keydown", (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const isEditableTarget =
				!!target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			if (isEditableTarget) {
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.close();
			}
			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				this.zoomIn();
				return;
			}
			if (event.key === "-") {
				event.preventDefault();
				this.zoomOut();
				return;
			}
			if (event.key === "0") {
				event.preventDefault();
				this.resetZoom();
			}
		});
	}

	private detachZoomKeyListener(): void {
		if (this.zoomKeyUnlistener) {
			this.zoomKeyUnlistener();
			this.zoomKeyUnlistener = undefined;
		}
	}
}
