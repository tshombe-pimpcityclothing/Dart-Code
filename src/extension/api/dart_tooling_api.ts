import * as vs from "vscode";
import { Device } from "../../shared/flutter/daemon_interfaces";
import { IAmDisposable } from "../../shared/interfaces";
import { disposeAll } from "../../shared/utils";
import { FlutterDeviceManager } from "../../shared/vscode/device_manager";

const debugMode = true;

export class DartApi implements IAmDisposable {
	protected readonly disposables: vs.Disposable[] = [];
	private apis: { [key: string]: ToolApi } = {};

	constructor(readonly onReceiveMessage: vs.Event<any>, private readonly post: (message: any) => void, private readonly deviceManager: FlutterDeviceManager | undefined) {
		const addApi = (api: ToolApi) => this.apis[api.apiName] = api;
		addApi(new VsCodeApi(this, deviceManager));

		this.disposables.push(onReceiveMessage(this.handleMessage, this));
	}

	public postMessage(message: any): void {
		this.post({ "jsonrpc": "2.0", ...message });
	}

	private async handleMessage(message: any): Promise<void> {
		if (debugMode)
			console.log(`VS CODE GOT: ${JSON.stringify(message)}`);

		const method = message.method;
		if (typeof method !== "string") return;

		const apiName = method.split(".")[0];
		const methodName = method.substring(apiName.length + 1);
		const handler = this.apis[apiName];
		if (!handler) {
			if (message.id) {
				this.postMessage({ "id": message.id, "error": "No handler for '${apiName}' API" });
			}
			return;
		}

		try {
			const result = await handler.handleRequest(methodName, message.params);
			if (message.id !== undefined) {
				this.postMessage({ "id": message.id, result });
			}
		} catch (e) {
			if (message.id !== undefined) {
				this.postMessage({ "id": message.id, "error": `${e}` });
			}
		}
	}

	public dispose(): any {
		disposeAll(this.disposables);
		disposeAll(Object.values(this.apis));
	}
}

abstract class ToolApi {
	protected readonly disposables: vs.Disposable[] = [];

	abstract api: DartApi;
	abstract apiName: string;
	abstract handleRequest(method: string, params: any): Promise<any>;

	public sendEvent(method: string, params: any) {
		this.api.postMessage({ method: `${this.apiName}.${method}`, params });
	}

	public dispose(): any {
		disposeAll(this.disposables);
	}
}

class VsCodeApi extends ToolApi {
	constructor(public readonly api: DartApi, private readonly deviceManager: FlutterDeviceManager | undefined) {
		super();
		if (deviceManager)
			this.disposables.push(deviceManager?.onCurrentDeviceChanged(this.onCurrentDeviceChanged, this));
	}

	private onCurrentDeviceChanged(device: Device | undefined): any {
		this.sendEvent("selectedDeviceChanged", { "device": this.asApiDevice(device) });
	}

	readonly apiName = "vsCode";

	public async handleRequest(method: string, params: any): Promise<any> {
		// TODO(dantup): Should we make checkAvailable toplevel, so the host can
		//  always return false for something it has no handler for?
		if (method === "checkAvailable") {
			return true;
		} else if (method === "getSelectedDevice") {
			return this.asApiDevice(this.deviceManager?.currentDevice);
		} else if (method === "executeCommand") {
			return await vs.commands.executeCommand(params.command as string, params.arguments);
		}
	}

	private asApiDevice(device: Device | undefined) {
		return device
			? {
				"category": device.category,
				"emulator": device.emulator,
				"ephemeral": device.ephemeral,
				"id": device.id,
				"name": device.name,
				"platform": device.platform,
				"platformType": device.platformType,
			}
			: null;
	}
}
