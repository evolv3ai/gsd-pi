// gsd-pi — Shared interview UI dialog border contract

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { visibleWidth } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent";
import {
	showInterviewRound,
	showWrapUpScreen,
	type Question,
	type RoundResult,
	type WrapUpResult,
} from "../interview-ui.js";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ENTER = "\r";
const ESC = "\x1b";

before(() => { initTheme(); });

type RenderWidget = {
	render(width: number): string[];
	handleInput(input: string): void;
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function assertFullOuterBorder(lines: string[], width: number): void {
	assert.ok(lines.length >= 2, "dialog must include top and bottom borders");

	for (const [index, line] of lines.entries()) {
		assert.equal(visibleWidth(line), width, `line ${index} must fill dialog width`);
	}

	const top = stripAnsi(lines[0] ?? "");
	const bottom = stripAnsi(lines.at(-1) ?? "");
	assert.match(top, /^╭.*╮$/, `top border missing full corners: ${top}`);
	assert.match(bottom, /^╰.*╯$/, `bottom border missing full corners: ${bottom}`);

	for (let index = 1; index < lines.length - 1; index++) {
		const line = stripAnsi(lines[index] ?? "");
		assert.match(line, /^[│├]/, `line ${index} missing left border: ${line}`);
		assert.match(line, /[│┤]$/, `line ${index} missing right border: ${line}`);
	}
}

function mockTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		accent: (text: string) => text,
		success: (text: string) => text,
		warning: (text: string) => text,
		error: (text: string) => text,
		info: (text: string) => text,
		muted: (text: string) => text,
		dimmed: (text: string) => text,
	};
}

async function captureInterviewWidget(
	questions: Question[],
): Promise<RenderWidget> {
	let widget: RenderWidget | undefined;

	await showInterviewRound(questions, {}, {
		ui: {
			custom: (factory: any) => {
				widget = factory(
					{ requestRender: () => {} },
					mockTheme(),
					{},
					(_result: RoundResult) => {},
				);
				return Promise.resolve({ endInterview: false, answers: {} });
			},
		},
	} as any);

	assert.ok(widget, "interview widget should be created");
	return widget;
}

async function captureWrapUpWidget(): Promise<RenderWidget> {
	let widget: RenderWidget | undefined;

	await showWrapUpScreen({
		headline: "Ready to wrap up?",
		progress: "4 questions answered",
		keepGoingLabel: "Keep going",
		satisfiedLabel: "I'm satisfied",
	}, {
		ui: {
			custom: (factory: any) => {
				widget = factory(
					{ requestRender: () => {} },
					mockTheme(),
					{},
					(_result: WrapUpResult) => {},
				);
				return Promise.resolve({ satisfied: false });
			},
		},
	} as any);

	assert.ok(widget, "wrap-up widget should be created");
	return widget;
}

describe("interview-ui dialog borders", () => {
	const questions: Question[] = [
		{
			id: "project_type",
			header: "Project Type",
			question: "What type of project?",
			options: [
				{ label: "Web App", description: "Frontend or full-stack" },
				{ label: "CLI Tool", description: "Command-line utility" },
			],
		},
	];

	it("renders the main question screen with a full border", async () => {
		const widget = await captureInterviewWidget(questions);
		assertFullOuterBorder(widget.render(80), 80);
	});

	it("renders the preview split screen with a full border", async () => {
		const widget = await captureInterviewWidget([{
			...questions[0],
			options: [
				{
					label: "Web App",
					description: "Frontend or full-stack",
					preview: "### Stack\n\nUse React with a typed API boundary.",
				},
			],
		}]);
		assertFullOuterBorder(widget.render(100), 100);
	});

	it("renders review and exit confirmation screens with full borders", async () => {
		const widget = await captureInterviewWidget(questions);

		widget.handleInput(ENTER);
		assertFullOuterBorder(widget.render(80), 80);

		const exitWidget = await captureInterviewWidget(questions);
		exitWidget.handleInput(ESC);
		assertFullOuterBorder(exitWidget.render(80), 80);
	});

	it("renders the wrap-up screen with a full border", async () => {
		const widget = await captureWrapUpWidget();
		assertFullOuterBorder(widget.render(80), 80);
	});
});
