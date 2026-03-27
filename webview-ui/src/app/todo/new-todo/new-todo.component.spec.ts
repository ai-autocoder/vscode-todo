import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { FormsModule } from "@angular/forms";
import { BehaviorSubject } from "rxjs";
import { TodoService } from "../todo.service";
import { NewTodoComponent } from "./new-todo.component";

describe("NewTodoComponent", () => {
	let component: NewTodoComponent;
	let fixture: ComponentFixture<NewTodoComponent>;

	beforeEach(async () => {
		const serviceStub: Partial<TodoService> = {
			getSelectionState: () =>
				new BehaviorSubject({ hasSelection: false, selectedCount: 0, totalCount: 0 }).asObservable(),
			setSelectionState: () => undefined,
		};

		await TestBed.configureTestingModule({
			declarations: [NewTodoComponent],
			imports: [FormsModule],
			providers: [{ provide: TodoService, useValue: serviceStub }],
			schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
		}).compileComponents();
	});

	beforeEach(() => {
		fixture = TestBed.createComponent(NewTodoComponent);
		component = fixture.componentInstance;
		fixture.detectChanges();
	});

	it("should create", () => {
		expect(component).toBeTruthy();
	});
});
