import * as vs from "vscode";
import { FlutterWidgetPropertyValue } from "../../shared/analysis/lsp/custom_protocol";
import { IAmDisposable } from "../../shared/interfaces";
import { disposeAll } from "../../shared/utils";
import { resolvedPromise } from "../../shared/utils/promises";
import { LspAnalyzer } from "../analysis/analyzer_lsp";
import { isDartDocument } from "../editors";

export class FlutterSidebar implements IAmDisposable {
	protected readonly disposables: vs.Disposable[] = [];
	private webViewProvider = new MyWebViewProvider();
	private currentStreamSub: vs.Disposable | undefined;

	constructor(private readonly analyzer: LspAnalyzer) {
		this.disposables.push(vs.window.registerWebviewViewProvider("dartFlutterSidebar", this.webViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));
		this.disposables.push(vs.window.onDidChangeTextEditorSelection(this.queueSideBarUpdate, this));
		this.disposables.push(vs.workspace.onDidChangeTextDocument(this.queueSideBarUpdate, this));
	}

	private lastEdit: Promise<any> = resolvedPromise;

	private sidebarUpdateTimer: NodeJS.Timer | undefined;
	private sidebarUpdateCancellationTokenSource: vs.CancellationTokenSource | undefined;
	private queueSideBarUpdate() {
		if (this.sidebarUpdateTimer) {
			clearTimeout(this.sidebarUpdateTimer);
		}
		this.sidebarUpdateCancellationTokenSource?.cancel();

		const token = (this.sidebarUpdateCancellationTokenSource = new vs.CancellationTokenSource()).token;
		this.sidebarUpdateTimer = setTimeout(() => {
			this.sidebarUpdateTimer = undefined;
			this.updateSidebar(token);
		}, 200);
	}

	private async updateSidebar(token?: vs.CancellationToken): Promise<void> {
		const editor = vs.window.activeTextEditor;
		const document = editor?.document;
		// TODO(dantup): Clear sidebar on all of these returns.
		if (!document || !isDartDocument(document))
			return;

		const selection = editor.selections && editor.selections.length ? editor.selection : undefined;
		if (!selection)
			return;

		// TODO: We could skip this if the side bar isn't visible, as long as we detect when it becomes visible
		// and send the request for the current cursor pos.
		const offset = document.offsetAt(selection.start);
		const flutterWidgetDescription = await this.analyzer.getFlutterWidgetDescription(
			{
				position: this.analyzer.client.code2ProtocolConverter.asPosition(selection.start),
				textDocument: this.analyzer.client.code2ProtocolConverter.asVersionedTextDocumentIdentifier(document),
			},
		);

		if (token?.isCancellationRequested || !flutterWidgetDescription)
			return;

		console.log(flutterWidgetDescription);

		this.currentStreamSub?.dispose();
		const message = {
			method: "setWidget",
			params: {
				description: flutterWidgetDescription,
				offset,
				uri: document.uri.toString(),
			},
		};
		console.log(`==> ${JSON.stringify(message)}`);
		this.webViewProvider.webviewView?.webview.postMessage(message);

		this.currentStreamSub = this.webViewProvider.webviewView?.webview.onDidReceiveMessage(async (message) => {
			console.log(`<== ${JSON.stringify(message)}`);
			const method = message.method;
			const params = message.params as { id: number, value: FlutterWidgetPropertyValue };
			if (method === "setWidgetPropertyValue") {
				const edit = await this.analyzer.setFlutterWidgetPropertyValue(params);
				if (!edit)
					return;
				if (await vs.workspace.applyEdit(await this.analyzer.client.protocol2CodeConverter.asWorkspaceEdit(edit, undefined))) {
					// TODO: Why we need this?
					// TODO: We have an issue that every watch event invalidates stuff, so a Flutter hot reload
					//  writes files, invalidates the IDs, etc.
					setTimeout(() => this.updateSidebar(), 500);
					this.triggerHotReload(document);
				}
			}
		});
	}

	private hotReloadTimer: NodeJS.Timer | undefined;
	private triggerHotReload(document: vs.TextDocument) {
		if (this.hotReloadTimer) {
			clearTimeout(this.hotReloadTimer);
		}
		this.hotReloadTimer = setTimeout(async () => {
			this.hotReloadTimer = undefined;
			// TODO(dantup): Trigger reload if reload-on-save is disabled.
			await document?.save();
			// TODO: Hack to try and work around the hot reload invalidating the data
			//  we can't do this for real, we need a better way.
			setTimeout(() => this.updateSidebar(), 500);
		}, 250);
	}

	public dispose(): any {
		disposeAll(this.disposables);
	}
}

class MyWebViewProvider implements vs.WebviewViewProvider {
	public webviewView: vs.WebviewView | undefined;
	public resolveWebviewView(webviewView: vs.WebviewView, context: vs.WebviewViewResolveContext<unknown>, token: vs.CancellationToken): void | Thenable<void> {
		this.webviewView = webviewView;
		// TODO: Trigger first postMessage if we already had a selection before we showed this.

		const url = "http://localhost:8989/";
		const pageScript = `
		const vscode = acquireVsCodeApi();
		window.addEventListener('message', (event) => {
			if (event.data.method === "setWidgetPropertyValue") {
				console.log(\`Passing message to vscode: \${event.data}\`);
				vscode.postMessage(event.data);
				return;
			}
			const myframe = document.getElementById('myframe');
			console.log(\`Passing message to inner frame: \${event.data}\`);
			myframe.contentWindow.postMessage(event.data, "${url}");

		});
		`;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [],
		};
		webviewView.webview.html = `
			<html>
			<head>
			<meta http-equiv="Content-Security-Policy" content="default-src *; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
			<script>${pageScript}</script>
			</head>
			<body><iframe id="myframe" src="${url}" frameborder="0" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%"></iframe></body>
			</html>
			`;

	}
}
