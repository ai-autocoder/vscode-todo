import * as assert from "assert";
import { tests } from "../../../todo/importer";

suite("isTodoPartialInput()", () => {
	test("return true if at least one element in array has text property", () => {
		const validTodoArray = [
			{
				id: 1282947365473357,
				text: "test",
				completed: false,
				isMarkdown: false,
				isNote: false,
				creationDate: "2024-05-18T16:29:45.870Z",
			},
			{
				id: 1282947365473357,
				text: "test",
				completed: false,
				isMarkdown: false,
				isNote: false,
				creationDate: "2024-05-18T16:31:02.448Z",
			},
			{
				id: 1282947365473354,
				text: "test",
				completed: false,
				creationDate: "2024-05-05T19:00:21.182Z",
				isMarkdown: true,
				isNote: false,
			},
			{
				text: "test",
				completed: true,
				isMarkdown: false,
				isNote: false,
				creationDate: "2024-05-18T16:29:45.870Z",
				completionDate: "2024-05-18T17:45:28.031Z",
			},
			{
				id: 1282947365473355,
				completed: true,
				isMarkdown: false,
				isNote: false,
				creationDate: "2024-05-18T16:29:45.870Z",
				completionDate: "2024-05-18T17:45:26.990Z",
			},
			{},
			{ completed: true, isMarkdown: false, isNote: false },
		];
		assert.strictEqual(tests.isTodoPartialInput(validTodoArray), true);
	});
	test("return false if missing text property in all elements", () => {
		const invalidTodoArray = [
			{ completed: true, isMarkdown: false, isNote: false },
			{
				id: 1282947365473357,
				completed: false,
				isMarkdown: false,
				isNote: false,
				creationDate: "2024-05-18T16:31:02.448Z",
			},
		];
		assert.strictEqual(tests.isTodoPartialInput(invalidTodoArray), false);
	});
	test("return false if empty array", () => {
		const invalidTodoArray = [{}];
		assert.strictEqual(tests.isTodoPartialInput(invalidTodoArray), false);
	});
	test("return false if array has no objects", () => {
		const invalidTodoArray = ["text"];
		assert.strictEqual(tests.isTodoPartialInput(invalidTodoArray), false);
	});
});

suite("isTodoFilesDataPartialInput()", () => {
	test("returns true if at least one element in the object is valid", () => {
		const files = {
			"c:\\Users\\test\\fileName.txt": [
				{
					id: 2418412004652330,
					text: "test",
					completed: false,
					creationDate: "2024-05-05T19:00:14.340Z",
					isMarkdown: false,
					isNote: false,
				},
			],
			"c:\\Users\\test\\fileName2.txt": [
				{
					id: 2530813296708339,
					completed: false,
					creationDate: "2024-05-05T19:00:10.920Z",
					isMarkdown: false,
					isNote: false,
				},
				{},
			],
			"": [],
		};
		assert.strictEqual(tests.isTodoFilesDataPartialInput(files), true);
	});

	test("return false if empty object", () => {
		const files = {};
		assert.strictEqual(tests.isTodoFilesDataPartialInput(files), false);
	});

	test("return false if the path is not valid", () => {
		const files = {
			"": [
				{
					id: 2418412004652330,
					text: "test",
					completed: false,
					creationDate: "2024-05-05T19:00:14.340Z",
					isMarkdown: false,
					isNote: false,
				},
			],
		};
		assert.strictEqual(tests.isTodoFilesDataPartialInput(files), false);
	});
});

suite("filterValidFilesData()", () => {
	test("filters records where the path is empty string and if the todo is not valid", () => {
		const files = {
			"c:\\Users\\someFile.txt": [
				{
					id: 2418412004652330,
					text: "yjyj",
					completed: false,
					creationDate: "2024-05-05T19:00:14.340Z",
					isMarkdown: false,
					isNote: false,
				},
			],
			"": [
				{
					id: 2530813296708339,
					text: "dthjtn",
					completed: false,
					creationDate: "2024-05-05T19:00:10.920Z",
					isMarkdown: false,
					isNote: false,
				},
			],
			"c:\\Users\\someFile2.txt": [
				{
					id: 2530813296708340,
					completed: false,
					creationDate: "2024-05-05T19:00:10.920Z",
					isMarkdown: false,
					isNote: false,
				},
			],
		};
		const expectedFiltered = {
			"c:\\Users\\someFile.txt": [
				{
					id: 2418412004652330,
					text: "yjyj",
					completed: false,
					creationDate: "2024-05-05T19:00:14.340Z",
					isMarkdown: false,
					isNote: false,
				},
			],
		};
		// @ts-expect-error
		assert.deepStrictEqual(tests.filterValidFilesData(files), expectedFiltered);
	});
});

suite("isImportObject()", () => {
	test("returns true if contains valid data", () => {
		const validData = {
			user: [],
			workspace: [
				{
					id: 227133633519912,
					text: '# test markdown\n\n```javascript\n    const someVariable = "Hello world!";\n```',
					completed: false,
					creationDate: "2024-06-08T16:10:37.280Z",
					isMarkdown: true,
					isNote: false,
				},
				{
					id: 41152449671784,
					text: "test",
					completed: false,
					creationDate: "2024-06-08T16:10:21.733Z",
					isMarkdown: false,
					isNote: false,
				},
			],
			files: {
				"c:\\Users\\myFile.txt": [
					{
						id: 2418412004652330,
						text: "yjyj",
						completed: false,
						creationDate: "2024-05-05T19:00:14.340Z",
						isMarkdown: false,
						isNote: false,
					},
				],
				"c:\\Users\\myFile2.txt": [
					{
						id: 2530813296708339,
						text: "dthjtn",
						completed: false,
						creationDate: "2024-05-05T19:00:10.920Z",
						isMarkdown: false,
						isNote: false,
					},
				],
			},
		};
		assert.strictEqual(tests.isImportObject(validData), true);
	});
});
