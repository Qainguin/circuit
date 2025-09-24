import { WebSocket, WebSocketServer } from "ws";
import {
  existsSync,
  mkdirSync,
  promises as fsPromises,
  rename,
  renameSync,
  unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { spawn, spawnSync } from "child_process";
import { unzipSync, zip } from "fflate";
import { randomBytes } from "crypto";
import fetch from "node-fetch";

const WSS_PORT = 8123;
const TEMPLATES_DIR = join(__dirname, "templates");
const TEMPLATES_URL =
  "https://bxpw3sizvo.ufs.sh/f/UdAfxUrQgajHcmnmhB92PGjRYfJ5I18yqrNSFiDAdQ4tUZVO";

// --- NEW CODE ADDITION ---
async function setupTemplates() {
  if (existsSync(TEMPLATES_DIR)) {
    console.log("Templates directory already exists. Skipping download.");
    return;
  }

  console.log(
    "Templates directory not found. Downloading and unzipping templates..."
  );
  try {
    const response = await fetch(TEMPLATES_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch templates: ${response.statusText}`);
    }

    console.log(TEMPLATES_DIR);

    const arrayBuffer = await response.arrayBuffer();
    const zipBuffer = new Uint8Array(arrayBuffer);

    const zipped = await fsPromises.writeFile(TEMPLATES_DIR, zipBuffer);

    renameSync(TEMPLATES_DIR, TEMPLATES_DIR + ".zip");

    spawnSync("unzip", ["templates.zip"], { cwd: "src" });

    unlinkSync("src/templates.zip");

    console.log("Templates downloaded and unzipped successfully.");
  } catch (error) {
    console.error("Failed to set up templates:", error);
    // Exit the process if we can't get the templates, as the server will not function correctly.
    process.exit(1);
  }
}
// --- END NEW CODE ADDITION ---

const allowedOrigins = [
  "http://localhost:5173",
  "https://amperage.dev",
  "https://websocket.tech"
];

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) {
    return Buffer.concat(
      raw.map((r) => (Buffer.isBuffer(r) ? r : Buffer.from(r as any)))
    );
  }
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (ArrayBuffer.isView(raw))
    return Buffer.from((raw as ArrayBufferView).buffer);
  if (typeof raw === "string") return Buffer.from(raw);
  throw new TypeError("Unsupported RawData type for buffer conversion");
}

interface ClientWebSocket extends WebSocket {
  isAlive: boolean;
}

const wss = new WebSocketServer({
  port: WSS_PORT,
  verifyClient: (info: any) => {
    // Check if the origin of the request is in our whitelist.
    const isAllowed = allowedOrigins.includes(info.origin);

    if (isAllowed) {
      console.log(`Connection from allowed origin: ${info.origin}`);
    } else {
      console.warn(
        `Connection denied from unauthorized origin: ${info.origin}`
      );
    }

    // Return true to allow the connection, false to deny.
    return isAllowed;
  },
});

// --- NEW CODE MODIFICATION ---
// Wrap the main server logic in an async IIFE to call the setup function.
(async () => {
  await setupTemplates();

  console.log(`WebSocket server started on port ${WSS_PORT}`);

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const clientWs = ws as ClientWebSocket;
      if (!clientWs.isAlive) {
        return clientWs.terminate();
      }
      clientWs.isAlive = false;
      clientWs.ping();
    });
  }, 60000);

  // Use a Map to manage the state of each client's upload.
  const clientUploadState = new Map<
    WebSocket,
    {
      parts: Buffer[]; // CHANGED: This will now be used to collect all chunks.
      expectedSize: number | null;
      receivedBytes: number;
      tempDir: string | null;
    }
  >();

  wss.on("connection", (ws: WebSocket) => {
    const clientWs = ws as ClientWebSocket;
    clientWs.isAlive = true;
    clientWs.on("pong", () => {
      clientWs.isAlive = true;
    });

    console.log("New client connected!");
    clientUploadState.set(clientWs, {
      parts: [],
      expectedSize: null,
      receivedBytes: 0,
      tempDir: null,
    });

    clientWs.on(
      "message",
      async (data: WebSocket.RawData, isBinary: boolean) => {
        const state = clientUploadState.get(clientWs);
        if (!state) {
          console.error("No state found for client!");
          clientWs.terminate();
          return;
        }

        if (isBinary) {
          const chunk = rawDataToBuffer(data);
          state.receivedBytes += chunk.byteLength;
          state.parts.push(chunk);

          if (
            typeof state.expectedSize === "number" &&
            state.receivedBytes > state.expectedSize
          ) {
            clientWs.send(
              JSON.stringify({
                type: "error",
                message: "Received more data than expected. Aborting upload.",
              })
            );
            console.error(
              "Received more data than expected. Terminating client."
            );
            if (state.tempDir) {
              fsPromises
                .rm(state.tempDir, { recursive: true, force: true })
                .catch((err) =>
                  console.error("Failed to clean up dir after overflow:", err)
                );
            }
            clientUploadState.delete(clientWs);
            clientWs.terminate();
          }
          return;
        }

        try {
          const text = data.toString();
          const msg = JSON.parse(text);

          if (msg.type === "file_upload_start") {
            console.log(
              `Starting upload for file: ${msg.fileName}, size: ${msg.fileSize} bytes`
            );

            state.parts = [];
            state.expectedSize =
              typeof msg.fileSize === "number" ? msg.fileSize : null;
            state.receivedBytes = 0;

            const tempDirName = `build-${randomBytes(8).toString("hex")}`;
            state.tempDir = join(__dirname, "temp", tempDirName);
            if (!existsSync(state.tempDir)) {
              mkdirSync(state.tempDir, { recursive: true });
            }
            console.log(`Created temp directory: ${state.tempDir}`);
            clientWs.send(
              JSON.stringify({ type: "ack", message: "upload_started" })
            );
          } else if (msg.type === "file_upload_end") {
            console.log("All chunks received. Processing file...");

            if (!state.tempDir) {
              console.error(
                "File upload ended but no temp directory was created."
              );
              clientWs.send(
                JSON.stringify({
                  type: "error",
                  message: "Server state error.",
                })
              );
              return;
            }

            const fullZipBuffer = Buffer.concat(state.parts);

            if (
              typeof state.expectedSize === "number" &&
              state.expectedSize !== fullZipBuffer.length
            ) {
              console.warn(
                `Expected ${state.expectedSize} bytes but received ${fullZipBuffer.length}. Proceeding.`
              );
              clientWs.send(
                JSON.stringify({
                  type: "warning",
                  message: `size_mismatch: expected ${state.expectedSize}, got ${fullZipBuffer.length}`,
                })
              );
            }

            try {
              const files = unzipSync(new Uint8Array(fullZipBuffer));
              for (const name in files) {
                if (!Object.prototype.hasOwnProperty.call(files, name))
                  continue;
                const data = files[name];
                const filePath = join(state.tempDir!, name);
                const dir = dirname(filePath);
                if (!existsSync(dir)) {
                  mkdirSync(dir, { recursive: true });
                }
                await fsPromises.writeFile(filePath, data).catch((err) => {
                  console.error(`Failed to write file ${name}:`, err);
                });
              }

              // --- MODIFIED CODE ---
              if (existsSync(join(state.tempDir!, "project.pros"))) {
                console.log("Copying stuff from templates/ez/firmware...");
                await fsPromises.cp(
                  join(TEMPLATES_DIR, "ez", "firmware"),
                  join(state.tempDir!, "firmware"),
                  {
                    recursive: true,
                  }
                );
              }
              // --- END MODIFIED CODE ---

              console.log("Unzipping complete. Starting 'make' process...");

              let makeProcess;
              if (existsSync(join(state.tempDir!, "project.pros"))) {
                makeProcess = spawn(
                  "/root/pros",
                  ["build-compile-commands", "--no-analytics"],
                  {
                    cwd: state.tempDir,
                  }
                );
              } else {
                makeProcess = spawn("make", [], {
                  cwd: state.tempDir,
                });
              }

              makeProcess.stdout.on("data", (data) => {
                clientWs.send(
                  JSON.stringify({ type: "log", message: data.toString() })
                );
                console.log(data.toString());
              });
              makeProcess.stderr.on("data", (data) => {
                clientWs.send(
                  JSON.stringify({ type: "error", message: data.toString() })
                );
                console.log(data.toString());
              });

              makeProcess.on("close", async (code) => {
                console.log(`'make' process finished with code ${code}`);
                const buildState =
                  code === 0 ? "build_complete" : "build_failed";
                if (buildState === "build_complete") {
                  const isPros = existsSync(
                    join(state.tempDir!, "project.pros")
                  );
                  if (isPros) {
                    const hotBinPath = join(
                      state.tempDir!,
                      "bin",
                      "hot.package.bin"
                    );
                    const coldBinPath = join(
                      state.tempDir!,
                      "bin",
                      "cold.package.bin"
                    );

                    const hotFileExists = existsSync(hotBinPath);
                    const coldFileExists = existsSync(coldBinPath);

                    clientWs.send(
                      JSON.stringify({
                        type: "build_complete",
                        message: `'pros make' command completed with code ${code}.`,
                        files: {
                          hot: hotFileExists
                            ? (await fsPromises.readFile(hotBinPath)).toString(
                                "base64"
                              )
                            : null,
                          cold: coldFileExists
                            ? (await fsPromises.readFile(coldBinPath)).toString(
                                "base64"
                              )
                            : null,
                        },
                      })
                    );
                  } else {
                    const binPath = join(
                      state.tempDir!,
                      "build",
                      `${state.tempDir!.split("/").slice(-1)[0]}.bin`
                    );
                    const binFileExists = existsSync(binPath);
                    clientWs.send(
                      JSON.stringify({
                        type: "build_complete",
                        message: `'make' command completed with code ${code}.`,
                        files: {
                          monalith: binFileExists
                            ? (await fsPromises.readFile(binPath)).toString(
                                "base64"
                              )
                            : null,
                        },
                      })
                    );
                  }
                } else {
                  clientWs.send(
                    JSON.stringify({
                      type: "build_failed",
                      message: `'make' command failed with code ${code}.`,
                    })
                  );
                }

                await fsPromises.rm(state.tempDir!, {
                  recursive: true,
                  force: true,
                });
                console.log(`Cleaned up temporary directory: ${state.tempDir}`);
                clientUploadState.delete(clientWs);
              });
            } catch (error: any) {
              console.error(
                "An error occurred during unzipping or make:",
                error
              );
              clientWs.send(
                JSON.stringify({
                  type: "build_failed",
                  message: `Server error during build: ${error.message}`,
                })
              );
              if (state.tempDir) {
                await fsPromises.rm(state.tempDir, {
                  recursive: true,
                  force: true,
                });
              }
              clientUploadState.delete(clientWs);
            }
          }
        } catch (e) {
          console.error("Failed to parse incoming text message:", e);
          clientWs.send(
            JSON.stringify({
              type: "error",
              message: "Invalid control message received.",
            })
          );
        }
      }
    );

    clientWs.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "";
      console.log("Client disconnected. code=", code, "reason=", reasonStr);
      const state = clientUploadState.get(clientWs);
      if (state && state.tempDir) {
        fsPromises
          .rm(state.tempDir, { recursive: true, force: true })
          .catch((err) =>
            console.error("Failed to clean up dir on disconnect:", err)
          );
      }
      clientUploadState.delete(clientWs);
    });

    clientWs.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });

  wss.on("close", () => {
    clearInterval(interval);
    console.log("Server closed.");
  });
})();
