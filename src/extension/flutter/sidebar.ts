import * as vs from "vscode";
import { URI } from "vscode-uri";
import { WebSocketServer } from "ws";
import { EventEmitter } from "../../shared/events";
import { IAmDisposable } from "../../shared/interfaces";
import { disposeAll } from "../../shared/utils";
import { FlutterDeviceManager } from "../../shared/vscode/device_manager";
import { DartApi } from "../api/dart_tooling_api";
import { DevToolsManager } from "../sdk/dev_tools/manager";

export class FlutterSidebar implements IAmDisposable {
	protected readonly disposables: vs.Disposable[] = [];

	constructor(readonly devTools: DevToolsManager, readonly deviceManager: FlutterDeviceManager | undefined) {
		const webViewProvider = new MyWebViewProvider(devTools, deviceManager);
		this.disposables.push(webViewProvider);
		this.disposables.push(vs.window.registerWebviewViewProvider("dartFlutterSidebar", webViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));
		this.disposables.push(vs.commands.registerCommand("dart.connectExternalSidebar", () => webViewProvider.connectExternalSidebar()));
	}

	public dispose(): any {
		disposeAll(this.disposables);
	}
}

class MyWebViewProvider implements vs.WebviewViewProvider, IAmDisposable {
	protected readonly disposables: vs.Disposable[] = [];

	public webviewView: vs.WebviewView | undefined;
	private api: DartApi | undefined;
	private isExternalMode = false;
	constructor(private readonly devTools: DevToolsManager, private readonly deviceManager: FlutterDeviceManager | undefined) { }

	public dispose(): any {
		this.api?.dispose();
		disposeAll(this.disposables);
	}

	public async resolveWebviewView(webviewView: vs.WebviewView, context: vs.WebviewViewResolveContext<unknown>, token: vs.CancellationToken): Promise<void> {
		this.webviewView = webviewView;
		if (this.isExternalMode) {
			this.showExternalSidebarMessage();
			return;
		}

		this.api?.dispose();

		await this.devTools.start();
		const sidebarUrl = await this.devTools.urlFor("vsCodeFlutterPanel");
		if (!sidebarUrl) {
			webviewView.webview.html = `
			<html>
			<body><h1>Sidebar Unavailable</h1><p>The Flutter sidebar requires DevTools but DevTools failed to start.</p></body>
			</html>
			`;
			return;
		}

		const sidebarUri = URI.parse(sidebarUrl);
		const frameOrigin = `${sidebarUri.scheme}://${sidebarUri.authority}`;
		const pageScript = `
		const vscode = acquireVsCodeApi();
		window.addEventListener('message', (event) => {
			const devToolsFrame = document.getElementById('devToolsFrame');
			const message = event.data;

			// Handle any special commands first.
			switch (message.command) {
				case "_dart-code.setUrl":
					const theme = document.body.classList.contains('vscode-light') ? 'light': 'dark';
					const background = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background');
					const foreground = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground');
					const qsSep = message.url.includes("?") ? "&" : "?";
					let url = \`\${message.url}\${qsSep}theme=\${theme}&backgroundColor=\${encodeURIComponent(background)}&foregroundColor=\${encodeURIComponent(foreground)}\`;
					const fontSizeWithUnits = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size');
					if (fontSizeWithUnits && fontSizeWithUnits.endsWith('px')) {
						url += \`&fontSize=\${encodeURIComponent(parseFloat(fontSizeWithUnits))}\`;
					}
					if (devToolsFrame.src !== url)
						devToolsFrame.src = url;
					return;
			}

			if (event.origin == ${JSON.stringify(frameOrigin)}) {
				// Messages from the frame go up to VS Code.
				console.log(\`FRAME: Code <-- DevTools: \${JSON.stringify(message)}\`);
				vscode.postMessage(message);
			} else {
				// Messages not from the frame go to the frame.
				console.log(\`FRAME: Code --> DevTools: \${JSON.stringify(message)}\`);
				devToolsFrame.contentWindow.postMessage(message, ${JSON.stringify(frameOrigin)});
			}
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
			<body><iframe id="devToolsFrame" src="about:blank" frameborder="0" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%"></iframe></body>
			</html>
			`;

		this.api = new DartApi(
			webviewView.webview.onDidReceiveMessage,
			(message) => webviewView.webview.postMessage(message),
			this.deviceManager,
		);

		webviewView.webview.postMessage({ command: "_dart-code.setUrl", url: sidebarUrl });
	}

	private showExternalSidebarMessage() {
		if (!this.webviewView)
			return;

		this.webviewView.webview.html = `
			<html>
			<body><p>External Sidebar Mode</p></body>
			</html>
			`;
	}

	public connectExternalSidebar() {
		if (this.isExternalMode)
			return;

		this.isExternalMode = true;
		this.showExternalSidebarMessage();

		// Dispose any existing API for the embedded view.
		this.api?.dispose();

		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" /* TODO(dantup): PATH for auth token */ });
		this.disposables.push({ dispose() { wss.close(); } });

		wss.once("listening", () => {
			const address = wss.address();
			if (typeof address === "string")
				throw new Error("WebSocket address was unexpected string");
			const url = `ws://${address.address}:${address.port}/`;
			console.log(url);
		});

		wss.on("connection", (ws) => {
			// TODO(dantup): Auth key.
			const emitter = new EventEmitter();
			ws.on("message", (data) => {
				emitter.fire(JSON.parse(data.toString()));
			});

			this.api = new DartApi(
				emitter.event,
				(message) => ws.send(JSON.stringify(message)),
				this.deviceManager,
			);
		});
	}
}

