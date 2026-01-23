export type McpStatus = {
	enabled: boolean;
	running: boolean;
	trusted: boolean;
	readOnly: boolean;
	transport: "streamableHttp";
	port: number | null;
};
