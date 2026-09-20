import http from "node:http";
import { pathToFileURL } from "node:url";

export const serviceId = "craft-provenance";
export const serviceName = "传统工艺来源授权账";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

export function createServer() {
  return http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "未找到资源" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    createServer().listen(port, "0.0.0.0");
  }
}
