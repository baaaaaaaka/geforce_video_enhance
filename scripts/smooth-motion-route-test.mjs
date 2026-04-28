import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const chromePath = process.env.CHROME_PATH || findChrome();
const mpvPath = process.env.MPV_PATH || findExecutable(["mpv.com", "mpv.exe"]);
const presentMonPath = findPresentMon();
const localYtDlpScriptsPath = path.resolve(".tools", "yt-dlp-venv", "Scripts");
const testUrl = process.env.YOUTUBE_TEST_URL || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const runSeconds = Number(process.env.SMOOTH_MOTION_CAPTURE_SECONDS || 8);
const artifactRoot = path.resolve("artifacts", `smooth-motion-routes-${timestampForPath(new Date())}`);

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to chrome.exe and run again.");
}

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  throw new Error("This route test requires Node.js 22+ with global WebSocket and fetch.");
}

const chromeCases = [
  {
    name: "baseline",
    args: []
  },
  {
    name: "dcomp-off-d3d11",
    args: ["--disable-direct-composition", "--use-angle=d3d11"]
  },
  {
    name: "dcomp-off-vulkan",
    args: [
      "--disable-direct-composition",
      "--use-angle=vulkan",
      "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE"
    ]
  },
  {
    name: "dcomp-tint",
    args: ["--tint-dc-layer"]
  },
  {
    name: "video-overlays-off",
    args: ["--disable-direct-composition-video-overlays"]
  },
  {
    name: "aggressive-copyback",
    args: [
      "--disable-direct-composition",
      "--use-angle=d3d11",
      "--disable-accelerated-video-decode",
      "--disable-zero-copy-dxgi-video"
    ]
  }
];
const selectedCaseNames = (process.env.SMOOTH_MOTION_CASES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const selectedChromeCases = selectedCaseNames.length
  ? chromeCases.filter((testCase) => selectedCaseNames.includes(testCase.name))
  : chromeCases;

function findChrome() {
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LocalAppData || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LocalAppData || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function findExecutable(names) {
  for (const name of names) {
    try {
      const result = execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .find((line) => fs.existsSync(line));
      if (result) {
        return result;
      }
    } catch {
      // Keep trying.
    }
  }
  return null;
}

function findPresentMon() {
  if (process.env.PRESENTMON_PATH) {
    return process.env.PRESENTMON_PATH;
  }

  const candidates = [
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "RivaTuner Statistics Server",
      "Plugins",
      "Client",
      "PresentMonDataProvider",
      "PresentMon-2.3.1-x64.exe"
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "RivaTuner Statistics Server",
      "Plugins",
      "Client",
      "PresentMonDataProvider",
      "PresentMon-1.10.0-x64.exe"
    ),
    path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "NVIDIA Corporation",
      "FrameViewSDK",
      "bin",
      "PresentMon_x64.exe"
    )
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForJson(url, timeoutMs = 20000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();

    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }

      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result || {});
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;

    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function attachPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);

  return sessionId;
}

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise,
      returnByValue: true
    },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }

  return result.result.value;
}

async function readPageText(cdp, url, settleMs = 1500) {
  const sessionId = await attachPage(cdp, url);
  await sleep(settleMs);
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const seen = new Set();
      const chunks = [];
      const collect = (root) => {
        if (!root || seen.has(root)) {
          return;
        }
        seen.add(root);
        const text = root.innerText || root.textContent || "";
        if (text.trim()) {
          chunks.push(text);
        }
        const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const node of nodes) {
          if (node.shadowRoot) {
            collect(node.shadowRoot);
          }
        }
      };
      collect(document.documentElement);
      return chunks.join("\\n");
    })()`
  );
}

function extractInterestingGpuLines(text) {
  const patterns = [
    /Graphics Feature Status/i,
    /Canvas:/i,
    /Compositing:/i,
    /Direct Rendering Display Compositor:/i,
    /Video Decode:/i,
    /Vulkan:/i,
    /GL_VENDOR/i,
    /GL_RENDERER/i,
    /GL_VERSION/i,
    /ANGLE/i,
    /DirectComposition/i,
    /Applied Workarounds/i,
    /Problems Detected/i
  ];

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && patterns.some((pattern) => pattern.test(line)))
    .slice(0, 120);
}

function withAutoplay(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("autoplay", "1");
  parsed.searchParams.set("mute", "1");
  return parsed.toString();
}

async function waitForYoutubeVideo(cdp, sessionId) {
  const started = Date.now();
  let state = null;

  while (Date.now() - started < 60000) {
    state = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const video = document.querySelector("video");
        const player = document.querySelector("#movie_player");
        return {
          href: location.href,
          title: document.title,
          hasVideo: !!video,
          readyState: video?.readyState ?? null,
          paused: video?.paused ?? null,
          currentTime: video?.currentTime ?? null,
          videoWidth: video?.videoWidth ?? null,
          videoHeight: video?.videoHeight ?? null,
          playbackQuality: typeof player?.getPlaybackQuality === "function" ? player.getPlaybackQuality() : null,
          availableQualityLevels: typeof player?.getAvailableQualityLevels === "function" ? player.getAvailableQualityLevels() : null,
          statsText: document.querySelector(".html5-video-info-panel-content")?.innerText || ""
        };
      })()`
    );

    if (state.hasVideo && state.readyState >= 2 && state.videoWidth > 0 && state.videoHeight > 0) {
      return state;
    }

    await sleep(1000);
  }

  throw new Error(`YouTube video was not ready. Last state: ${JSON.stringify(state)}`);
}

async function startYoutubePlayback(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const video = document.querySelector("video");
      const player = document.querySelector("#movie_player");
      if (!video) {
        return { ok: false, reason: "no-video" };
      }

      video.muted = true;
      video.volume = 0;

      try {
        await video.play();
      } catch (error) {
        player?.click?.();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          await video.play();
        } catch (secondError) {
          return { ok: false, reason: secondError.message };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));
      return {
        ok: true,
        paused: video.paused,
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        quality: typeof player?.getPlaybackQuality === "function" ? player.getPlaybackQuality() : null,
        availableQualityLevels: typeof player?.getAvailableQualityLevels === "function" ? player.getAvailableQualityLevels() : null,
        droppedFrames: typeof video.getVideoPlaybackQuality === "function"
          ? video.getVideoPlaybackQuality().droppedVideoFrames
          : null,
        totalFrames: typeof video.getVideoPlaybackQuality === "function"
          ? video.getVideoPlaybackQuality().totalVideoFrames
          : null
      };
    })()`,
    true
  );
}

async function captureScreenshot(cdp, sessionId, filePath) {
  await cdp.send("Page.bringToFront", {}, sessionId);
  await sleep(300);
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
}

function getChromeProcessTree(profilePath) {
  const escaped = profilePath.replace(/'/g, "''");
  const script = `
    $profile = '${escaped}';
    $all = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
      Where-Object { $_.CommandLine -like "*$profile*" -or $_.CommandLine -like "*--type=*" };
    $roots = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
      Where-Object { $_.CommandLine -like "*$profile*" } |
      Select-Object -ExpandProperty ProcessId;
    $seen = @{};
    $queue = New-Object System.Collections.Generic.Queue[int];
    foreach ($root in $roots) { $queue.Enqueue([int]$root) }
    while ($queue.Count -gt 0) {
      $currentPid = $queue.Dequeue();
      if ($seen.ContainsKey($currentPid)) { continue }
      $seen[$currentPid] = $true;
      Get-CimInstance Win32_Process -Filter "ParentProcessId = $currentPid" |
        Where-Object { $_.Name -eq 'chrome.exe' } |
        ForEach-Object { $queue.Enqueue([int]$_.ProcessId) };
    }
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
      Where-Object { $seen.ContainsKey([int]$_.ProcessId) } |
      Select-Object ProcessId, ParentProcessId, Name, CommandLine |
      ConvertTo-Json -Compress
  `;

  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function processLoadsModule(pid, moduleName) {
  try {
    const output = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/M", moduleName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.toLowerCase().includes(moduleName.toLowerCase());
  } catch {
    return false;
  }
}

async function runPresentMon(pids, outputFile, seconds) {
  if (!fs.existsSync(presentMonPath) || pids.length === 0) {
    return {
      ran: false,
      reason: !fs.existsSync(presentMonPath) ? "PresentMon not found" : "No target Chrome PIDs"
    };
  }

  if (!isElevated()) {
    return {
      ran: false,
      reason: "PresentMon capture skipped because this shell is not elevated"
    };
  }

  const args = [
    "--stop_existing_session",
    "--session_name",
    `SMRoute${process.pid}`,
    "--output_file",
    outputFile,
    "--timed",
    String(seconds),
    "--terminate_after_timed",
    "--track_gpu_video",
    "--no_console_stats"
  ];
  if (process.env.SMOOTH_MOTION_TRACK_FRAME_TYPE === "1") {
    args.push("--track_frame_type");
  }

  args.push("--process_name", path.basename(chromePath));

  const result = await spawnSyncText(presentMonPath, args, Math.max(30000, (seconds + 10) * 1000));
  return {
    ran: true,
    code: result.code,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
    outputFile,
    summary: fs.existsSync(outputFile) ? summarizePresentMonCsv(outputFile, new Set(pids.map((pid) => String(pid)))) : null
  };
}

function isElevated() {
  try {
    execFileSync("net.exe", ["session"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnSyncText(command, args, timeoutMs) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return waitForExitWithTimeout(child, timeoutMs).then((code) => ({ code, stdout, stderr }));
}

async function waitForExitWithTimeout(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function summarizePresentMonCsv(filePath, targetPidSet = null) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return { rows: 0 };
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const allRows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
  });

  const findColumn = (...candidates) => {
    const lower = header.map((name) => [name.toLowerCase(), name]);
    for (const candidate of candidates) {
      const found = lower.find(([name]) => name === candidate.toLowerCase());
      if (found) {
        return found[1];
      }
    }
    return null;
  };

  const processIdColumn = findColumn("ProcessID", "ProcessId", "Process ID");
  const presentModeColumn = findColumn("PresentMode", "Present Mode");
  const runtimeColumn = findColumn("Runtime");
  const appColumn = findColumn("Application");
  const frameTypeColumn = findColumn("FrameType", "Frame Type");
  const msBetweenPresentsColumn = findColumn("MsBetweenPresents");
  const msBetweenDisplayChangeColumn = findColumn("MsBetweenDisplayChange");
  const droppedColumn = findColumn("Dropped");
  const rows = targetPidSet && processIdColumn
    ? allRows.filter((row) => targetPidSet.has(String(row[processIdColumn])))
    : allRows;

  const numericAverage = (column) => {
    if (!column) {
      return null;
    }
    const values = rows
      .map((row) => Number(row[column]))
      .filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };

  const uniqueValues = (column) => {
    if (!column) {
      return [];
    }
    return [...new Set(rows.map((row) => row[column]).filter(Boolean))].slice(0, 30);
  };

  return {
    rows: rows.length,
    totalRows: allRows.length,
    columns: header,
    applications: uniqueValues(appColumn),
    processIds: uniqueValues(processIdColumn),
    runtimes: uniqueValues(runtimeColumn),
    presentModes: uniqueValues(presentModeColumn),
    frameTypes: uniqueValues(frameTypeColumn),
    avgMsBetweenPresents: numericAverage(msBetweenPresentsColumn),
    avgMsBetweenDisplayChange: numericAverage(msBetweenDisplayChangeColumn),
    droppedFrames: droppedColumn
      ? rows.reduce((sum, row) => sum + (Number(row[droppedColumn]) || 0), 0)
      : null
  };
}

async function runChromeCase(testCase) {
  const caseDir = path.join(artifactRoot, testCase.name);
  fs.mkdirSync(caseDir, { recursive: true });

  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `sm-route-${testCase.name}-`));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--autoplay-policy=no-user-gesture-required",
    "--window-position=80,80",
    "--window-size=1280,900",
    ...testCase.args,
    "about:blank"
  ];

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = {
    name: testCase.name,
    args: testCase.args,
    profile,
    caseDir
  };

  let cdp = null;
  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();
    result.browser = version.Browser;

    const versionText = await readPageText(cdp, "chrome://version", 1200);
    const gpuText = await readPageText(cdp, "chrome://gpu", 2500);
    fs.writeFileSync(path.join(caseDir, "chrome-version.txt"), versionText);
    fs.writeFileSync(path.join(caseDir, "chrome-gpu.txt"), gpuText);
    result.commandLine = versionText
      .split(/\r?\n/)
      .find((line) => line.includes("--user-data-dir") || line.includes("Command Line")) || "";
    result.gpuHighlights = extractInterestingGpuLines(gpuText);

    const youtubeSessionId = await attachPage(cdp, withAutoplay(testUrl));
    result.youtubeInitial = await waitForYoutubeVideo(cdp, youtubeSessionId);
    result.youtubePlayback = await startYoutubePlayback(cdp, youtubeSessionId);
    await captureScreenshot(cdp, youtubeSessionId, path.join(caseDir, "youtube.png"));

    const processTree = getChromeProcessTree(profile);
    result.processTree = processTree.map((processInfo) => ({
      processId: processInfo.ProcessId,
      parentProcessId: processInfo.ParentProcessId,
      commandType: extractChromeProcessType(processInfo.CommandLine || ""),
      commandLineContainsProfile: String(processInfo.CommandLine || "").includes(profile)
    }));

    const targetPids = [...new Set(result.processTree.map((processInfo) => Number(processInfo.processId)).filter(Boolean))];
    result.nvPresentLoaded = targetPids
      .map((pid) => ({ pid, loaded: processLoadsModule(pid, "NvPresent64.dll") }))
      .filter((entry) => entry.loaded);

    const presentMon = await runPresentMon(targetPids, path.join(caseDir, "presentmon.csv"), runSeconds);
    result.presentMon = presentMon;
  } catch (error) {
    result.error = error.stack || error.message;
  } finally {
    if (cdp) {
      cdp.close();
    }
    chrome.kill();
    await sleep(1000);
    killChromeProcessesForProfile(profile);
    await sleep(500);
    result.profileCleanup = await removeProfileWithRetry(profile);
    if (stderr.trim()) {
      fs.writeFileSync(path.join(caseDir, "chrome-stderr.txt"), stderr);
      result.chromeStderrTail = stderr.split(/\r?\n/).slice(-12);
    }
  }

  return result;
}

function killChromeProcessesForProfile(profilePath) {
  const pids = getChromeProcessTree(profilePath)
    .map((processInfo) => Number(processInfo.ProcessId || processInfo.processId))
    .filter(Boolean);

  for (const pid of [...new Set(pids)].sort((a, b) => b - a)) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Chrome may have already exited.
    }
  }
}

async function removeProfileWithRetry(profile) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return { removed: true, attempt };
    } catch (error) {
      if (attempt === 6) {
        return {
          removed: false,
          reason: error.code || error.message,
          profile
        };
      }

      await sleep(500 * attempt);
    }
  }

  return { removed: false, reason: "unknown", profile };
}

function extractChromeProcessType(commandLine) {
  const match = commandLine.match(/--type=([^\s"]+)/);
  return match ? match[1] : "browser";
}

async function runMpvProbe() {
  const caseDir = path.join(artifactRoot, "mpv-probe");
  fs.mkdirSync(caseDir, { recursive: true });

  if (!mpvPath) {
    return { ok: false, reason: "mpv not found" };
  }

  const version = execFileSync(mpvPath, ["--version"], { encoding: "utf8" }).split(/\r?\n/).slice(0, 8);
  const localYtDlpExe = path.join(localYtDlpScriptsPath, "yt-dlp.exe");
  const args = [
    "--no-config",
    "--idle=no",
    "--frames=1",
    "--msg-level=all=info",
    "--vo=gpu-next",
    "--gpu-api=d3d11",
    "--hwdec=d3d11va",
    ...(fs.existsSync(localYtDlpExe) ? [`--script-opts=ytdl_hook-ytdl_path=${localYtDlpExe}`] : []),
    testUrl
  ];
  const env = {
    ...process.env,
    Path: fs.existsSync(localYtDlpScriptsPath)
      ? `${localYtDlpScriptsPath};${process.env.Path || ""}`
      : process.env.Path,
    PATH: fs.existsSync(localYtDlpScriptsPath)
      ? `${localYtDlpScriptsPath};${process.env.PATH || process.env.Path || ""}`
      : process.env.PATH,
    http_proxy: "",
    https_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: ""
  };
  const result = await spawnWithTimeout(mpvPath, args, 30000, env);
  fs.writeFileSync(path.join(caseDir, "mpv-stdout.txt"), result.stdout);
  fs.writeFileSync(path.join(caseDir, "mpv-stderr.txt"), result.stderr);

  return {
    ok: result.code === 0,
    path: mpvPath,
    version,
    code: result.code,
    stdoutTail: result.stdout.split(/\r?\n/).slice(-20),
    stderrTail: result.stderr.split(/\r?\n/).slice(-30)
  };
}

async function spawnWithTimeout(command, args, timeoutMs, env = process.env) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const code = await waitForExitWithTimeout(child, timeoutMs);
  return { code, stdout, stderr };
}

async function main() {
  fs.mkdirSync(artifactRoot, { recursive: true });

  const chromeResults = [];
  for (const testCase of selectedChromeCases) {
    console.error(`Running Chrome route: ${testCase.name}`);
    chromeResults.push(await runChromeCase(testCase));
  }

  console.error("Running mpv route probe");
  const mpvProbe = await runMpvProbe();

  const summary = {
    createdAt: new Date().toISOString(),
    chromePath,
    presentMonPath,
    testUrl,
    runSeconds,
    artifactRoot,
    chromeResults,
    mpvProbe
  };

  const summaryPath = path.join(artifactRoot, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
