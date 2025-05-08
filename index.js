const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { spawn } = require("child_process");

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/downloads", express.static(path.join(__dirname, "output")));

// Helper function: Unpacks the obfuscated JavaScript code
function unPack(code) {
  function indent(code) {
    try {
      var tabs = 0,
        old = -1,
        add = "";
      for (var i = 0; i < code.length; i++) {
        if (code[i].indexOf("{") != -1) tabs++;
        if (code[i].indexOf("}") != -1) tabs--;

        if (old != tabs) {
          old = tabs;
          add = "";
          while (old > 0) {
            add += "\t";
            old--;
          }
          old = tabs;
        }

        code[i] = add + code[i];
      }
    } finally {
      tabs = null;
      old = null;
      add = null;
    }
    return code;
  }

  var env = {
    eval: function (c) {
      code = c;
    },
    window: {},
    document: {},
  };

  eval("with(env) {" + code + "}");

  code = (code + "")
    .replace(/;/g, ";\n")
    .replace(/{/g, "\n{\n")
    .replace(/}/g, "\n}\n")
    .replace(/\n;\n/g, ";\n")
    .replace(/\n\n/g, "\n");

  code = code.split("\n");
  code = indent(code);

  code = code.join("\n");
  return code;
}

// Helper function: Extracts video information from unpacked JavaScript
function extractVideoInfo(unpackedCode) {
  const videoInfo = {
    videoId: null,
    sources: [],
    thumbnailUrl: null,
    title: null,
    tracks: [],
    qualityLabels: {},
    playbackRates: [],
  };

  try {
    // Extract video ID
    const videoIdMatch = unpackedCode.match(/[?&]b=([^&"']+)/);
    if (videoIdMatch) {
      videoInfo.videoId = videoIdMatch[1];
    }

    // Extract sources (m3u8 links)
    const sourcesRegex = /sources\s*:\s*\[\s*{([^}]+)}\s*\]/g;
    let sourcesMatch;
    while ((sourcesMatch = sourcesRegex.exec(unpackedCode)) !== null) {
      const sourceData = sourcesMatch[1];

      // Extract file URL
      const fileMatch = sourceData.match(/file\s*:\s*["']([^"']+)["']/);
      if (fileMatch) {
        videoInfo.sources.push({
          file: fileMatch[1],
          type: fileMatch[1].includes(".m3u8") ? "hls" : "mp4",
        });
      }
    }

    // Extract all sources as an array
    const allSourcesMatch = unpackedCode.match(/sources\s*:\s*(\[[\s\S]*?\])/);
    if (allSourcesMatch) {
      const sourcesText = allSourcesMatch[1];
      const fileMatches = sourcesText.match(/file\s*:\s*["']([^"']+)["']/g);

      if (fileMatches && videoInfo.sources.length === 0) {
        fileMatches.forEach((match) => {
          const file = match.match(/file\s*:\s*["']([^"']+)["']/)[1];
          videoInfo.sources.push({
            file: file,
            type: file.includes(".m3u8") ? "hls" : "mp4",
          });
        });
      }
    }

    // Extract thumbnail URL
    const imageMatch = unpackedCode.match(/image\s*:\s*["']([^"']+)["']/);
    if (imageMatch) {
      videoInfo.thumbnailUrl = imageMatch[1];
    }

    // Try to extract title or file name
    const fileCodeMatch = unpackedCode.match(
      /file_code\s*:\s*["']([^"']+)["']/,
    );
    if (fileCodeMatch) {
      videoInfo.title = fileCodeMatch[1];
    }

    // Extract tracks (subtitles)
    const tracksRegex = /tracks\s*:\s*\[\s*{([^}]+)}\s*\]/g;
    let tracksMatch;
    while ((tracksMatch = tracksRegex.exec(unpackedCode)) !== null) {
      const trackData = tracksMatch[1];

      // Extract track info
      const trackFileMatch = trackData.match(/file\s*:\s*["']([^"']+)["']/);
      const trackLabelMatch = trackData.match(/label\s*:\s*["']([^"']+)["']/);
      const trackKindMatch = trackData.match(/kind\s*:\s*["']([^"']+)["']/);

      if (trackFileMatch) {
        videoInfo.tracks.push({
          file: trackFileMatch[1],
          label: trackLabelMatch ? trackLabelMatch[1] : "Unknown",
          kind: trackKindMatch ? trackKindMatch[1] : "captions",
        });
      }
    }

    // Extract quality labels
    const qualityLabelsRegex = /qualityLabels\s*:\s*{([^}]+)}/;
    const qualityLabelsMatch = qualityLabelsRegex.exec(unpackedCode);
    if (qualityLabelsMatch) {
      const qualityData = qualityLabelsMatch[1];
      const qualityEntries = qualityData.match(
        /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g,
      );

      if (qualityEntries) {
        qualityEntries.forEach((entry) => {
          const parts = entry.split(":");
          if (parts.length >= 2) {
            const key = parts[0].replace(/['"]/g, "").trim();
            const value = parts[1].replace(/['"]/g, "").trim();
            videoInfo.qualityLabels[key] = value;
          }
        });
      }
    }

    // Extract playback rates
    const playbackRatesRegex = /playbackRates\s*:\s*\[([\d\.,\s]+)\]/;
    const playbackRatesMatch = playbackRatesRegex.exec(unpackedCode);
    if (playbackRatesMatch) {
      const ratesStr = playbackRatesMatch[1];
      videoInfo.playbackRates = ratesStr
        .split(",")
        .map((rate) => parseFloat(rate.trim()));
    }

    return videoInfo;
  } catch (error) {
    console.error(`Error extracting video info: ${error.message}`);
    return videoInfo;
  }
}

// Helper function: Parse and format cookies for easier viewing
function parseCookies(cookieArray) {
  return cookieArray.map(cookie => {
    const parts = cookie.split(';');
    const mainPart = parts[0];
    const [name, value] = mainPart.split('=');
    
    // Extract additional attributes
    const attributes = {};
    parts.slice(1).forEach(part => {
      const [attrName, attrValue] = part.split('=').map(s => s.trim());
      attributes[attrName] = attrValue || true; // Some attributes like HttpOnly don't have values
    });
    
    return {
      name: name.trim(),
      value: value,
      attributes,
      raw: cookie
    };
  });
}

// Core function: Fetches the page and extracts video information
async function scrapeVideo(videoId) {
  if (!videoId) {
    throw new Error("Video ID is required");
  }

  try {
    const url = `https://zpjid.com/bkg/${videoId}?ref=animedub.pro`;
    console.log(`Fetching video data from: ${url}`);

    // Define the exact headers as specified by the user
    const headers = {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.5",
      "Alt-Used": "zpjid.com",
      "Connection": "keep-alive",
      "Cookie": "file_id=43620805; aff=40302; ref_url=animedub.pro; lang=1; prefetchAd_9254409=true",
      "DNT": "1",
      "Host": "zpjid.com",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0"
    };

    // Make the request with the exact headers
    const response = await axios.get(url, {
      headers: headers,
      withCredentials: true,
    });

    // Create output directory if it doesn't exist
    const outputDir = path.join(process.cwd(), "output", videoId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save raw HTML for debugging
    fs.writeFileSync(path.join(outputDir, "raw.html"), response.data);
    
    // Save headers information to a dedicated file
    fs.writeFileSync(
      path.join(outputDir, "headers.json"),
      JSON.stringify({
        requestHeaders: headers,
        responseHeaders: response.headers
      }, null, 2)
    );

    // Extract cookies from response
    const cookies = response.headers['set-cookie'] || [];
    console.log(`Received cookies: ${cookies.length ? 'Yes' : 'No'}`);
    
    // Parse cookies into a more readable format
    const parsedCookies = parseCookies(cookies);
    
    // Save cookies information
    fs.writeFileSync(
      path.join(outputDir, "cookies.json"),
      JSON.stringify({
        rawCookies: cookies,
        parsedCookies: parsedCookies,
        cookieHeader: headers.Cookie
      }, null, 2)
    );

    // Load HTML with cheerio
    const $ = cheerio.load(response.data);

    // Find the script that contains the packed code
    let packedCode = "";
    $("script").each((i, script) => {
      const content = $(script).html() || "";
      if (
        content.includes("eval(function(p,a,c,k,e,d)") &&
        content.includes("jwplayer")
      ) {
        packedCode = content;
        return false; // Break the loop once we find our target
      }
    });

    if (!packedCode) {
      throw new Error("Could not find packed code in the page");
    }

    // Save packed code for reference
    fs.writeFileSync(path.join(outputDir, "packed.js"), packedCode);

    // Unpack the JavaScript
    console.log(`Unpacking obfuscated JavaScript...`);
    const unpackedCode = unPack(packedCode);

    // Save the unpacked code to a file for inspection
    fs.writeFileSync(path.join(outputDir, "unpacked.js"), unpackedCode);

    // Extract video information
    const videoInfo = extractVideoInfo(unpackedCode);
    
    // Store headers and cookies in video info
    videoInfo.requestHeaders = headers;
    videoInfo.cookies = headers.Cookie;
    videoInfo.rawCookies = cookies;
    videoInfo.parsedCookies = parsedCookies;

    // Save video info to JSON file
    fs.writeFileSync(
      path.join(outputDir, "info.json"),
      JSON.stringify(videoInfo, null, 2),
    );

    return videoInfo;
  } catch (error) {
    console.error(`Error scraping video: ${error.message}`);
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
    }
    throw error;
  }
}

// Function to download video
function downloadVideo(url, outputPath, cookies = '') {
  return new Promise((resolve, reject) => {
    console.log(`Starting download using FFmpeg...`);
    console.log(`URL: ${url}`);
    console.log(`Output: ${outputPath}`);
    console.log(`Using cookies: ${cookies ? 'Yes' : 'No'}`);

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Prepare FFmpeg arguments with all required headers
    const ffmpegArgs = [
      '-headers', `Cookie: ${cookies}\r\n` +
                 `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\r\n` +
                 `Accept-Language: en-US,en;q=0.5\r\n` +
                 `Connection: keep-alive\r\n` +
                 `DNT: 1\r\n` +
                 `Host: zpjid.com\r\n` +
                 `Sec-Fetch-Dest: document\r\n` +
                 `Sec-Fetch-Mode: navigate\r\n` +
                 `Sec-Fetch-Site: none\r\n` +
                 `Sec-Fetch-User: ?1\r\n` +
                 `Upgrade-Insecure-Requests: 1\r\n` +
                 `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0\r\n`,
      '-i', url,
      '-c', 'copy', // Copy without re-encoding
      '-bsf:a', 'aac_adtstoasc',
      outputPath
    ];

    // Start download with FFmpeg
    const download = spawn('ffmpeg', ffmpegArgs);

    // Track progress (simplified for API)
    let progressData = {
      progress: 0,
      status: "downloading",
    };

    download.stderr.on("data", (data) => {
      const output = data.toString();

      // Extract duration
      const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch && !progressData.duration) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        progressData.duration = hours * 3600 + minutes * 60 + seconds;
      }

      // Extract progress
      const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseFloat(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;

        // Calculate percentage
        if (progressData.duration) {
          progressData.progress = Math.round(
            (currentTime / progressData.duration) * 100,
          );
          progressData.currentTime = currentTime;
        }
      }
    });

    download.on("close", (code) => {
      if (code === 0) {
        progressData.status = "completed";
        progressData.progress = 100;
        resolve(progressData);
      } else {
        progressData.status = "failed";
        progressData.error = `FFmpeg process exited with code ${code}`;
        reject(progressData);
      }
    });

    download.on("error", (err) => {
      progressData.status = "failed";
      progressData.error = err.message;
      reject(progressData);
    });
  });
}

// API Endpoints

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Video Scraper API is running" });
});

// Get video information
app.get("/api/videos/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoInfo = await scrapeVideo(videoId);
    res.json({
      success: true,
      data: videoInfo,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get cookies for a specific video
app.get("/api/videos/:videoId/cookies", (req, res) => {
  try {
    const { videoId } = req.params;
    const cookiePath = path.join(process.cwd(), "output", videoId, "cookies.json");
    
    if (!fs.existsSync(cookiePath)) {
      // If cookies file doesn't exist, try to fetch info first
      return res.status(404).json({
        success: false,
        error: "Cookies not found. Try fetching video info first.",
        message: "Use GET /api/videos/:videoId to fetch video info including cookies"
      });
    }
    
    // Read cookies from file
    const cookiesData = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
    
    res.json({
      success: true,
      data: cookiesData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get request headers for a specific video
app.get("/api/videos/:videoId/headers", (req, res) => {
  try {
    const { videoId } = req.params;
    const headersPath = path.join(process.cwd(), "output", videoId, "headers.json");
    
    if (!fs.existsSync(headersPath)) {
      return res.status(404).json({
        success: false,
        error: "Headers not found. Try fetching video info first.",
        message: "Use GET /api/videos/:videoId to fetch video info including headers"
      });
    }
    
    // Read headers from file
    const headersData = JSON.parse(fs.readFileSync(headersPath, "utf8"));
    
    res.json({
      success: true,
      data: headersData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// List all downloaded videos
app.get("/api/videos", (req, res) => {
  try {
    const outputDir = path.join(process.cwd(), "output");

    // Check if output directory exists
    if (!fs.existsSync(outputDir)) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Read all directories (each is a video ID)
    const videoDirs = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    // Get info for each video
    const videos = videoDirs.map((videoId) => {
      const videoDir = path.join(outputDir, videoId);
      const infoPath = path.join(videoDir, "info.json");
      const cookiePath = path.join(videoDir, "cookies.json");
      const headersPath = path.join(videoDir, "headers.json");

      if (fs.existsSync(infoPath)) {
        try {
          const videoInfo = JSON.parse(fs.readFileSync(infoPath, "utf8"));
          const hasCookies = fs.existsSync(cookiePath);
          const hasHeaders = fs.existsSync(headersPath);

          // Check for downloaded files
          const mp4Files = fs
            .readdirSync(videoDir)
            .filter((file) => file.endsWith(".mp4"))
            .map((file) => ({
              fileName: file,
              downloadUrl: `/downloads/${videoId}/${file}`,
            }));

          return {
            videoId,
            title: videoInfo.title,
            thumbnailUrl: videoInfo.thumbnailUrl,
            downloaded: mp4Files.length > 0,
            files: mp4Files,
            hasCookies: hasCookies,
            cookiesUrl: hasCookies ? `/api/videos/${videoId}/cookies` : null,
            hasHeaders: hasHeaders,
            headersUrl: hasHeaders ? `/api/videos/${videoId}/headers` : null
          };
        } catch (e) {
          return { videoId, error: e.message };
        }
      } else {
        return { videoId, status: "incomplete" };
      }
    });

    res.json({
      success: true,
      count: videos.length,
      data: videos,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Delete a downloaded video
app.delete("/api/videos/:videoId", (req, res) => {
  try {
    const { videoId } = req.params;
    const videoDir = path.join(process.cwd(), "output", videoId);

    if (!fs.existsSync(videoDir)) {
      return res.status(404).json({
        success: false,
        error: "Video not found",
      });
    }

    // Recursively delete the directory
    fs.rmSync(videoDir, { recursive: true, force: true });

    res.json({
      success: true,
      message: `Video ${videoId} deleted successfully`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Serve API documentation
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Video Scraper API</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #2c3e50; }
        h2 { color: #3498db; margin-top: 30px; }
        pre { background-color: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; }
        code { font-family: Consolas, Monaco, 'Andale Mono', monospace; }
        .endpoint { background-color: #e8f4fc; padding: 10px; border-left: 5px solid #3498db; margin-bottom: 20px; }
        .method { font-weight: bold; background-color: #3498db; color: white; padding: 3px 8px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>Video Scraper API</h1>
      <p>A RESTful API for scraping and downloading videos.</p>

      <h2>API Endpoints</h2>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/health</code></p>
        <p>Check if the API is running.</p>
        <pre><code>curl http://localhost:3000/api/health</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos/:videoId</code></p>
        <p>Get information about a video.</p>
        <pre><code>curl http://localhost:3000/api/videos/9q4yh8ji5k4w</code></pre>
      </div>
      
      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos/:videoId/cookies</code></p>
        <p>Get cookies for a specific video.</p>
        <pre><code>curl http://localhost:3000/api/videos/9q4yh8ji5k4w/cookies</code></pre>
      </div>
      
      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos/:videoId/headers</code></p>
        <p>Get request headers for a specific video.</p>
        <pre><code>curl http://localhost:3000/api/videos/9q4yh8ji5k4w/headers</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos</code></p>
        <p>List all downloaded videos.</p>
        <pre><code>curl http://localhost:3000/api/videos</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">DELETE</span> <code>/api/videos/:videoId</code></p>
        <p>Delete a downloaded video.</p>
        <pre><code>curl -X DELETE http://localhost:3000/api/videos/9q4yh8ji5k4w</code></pre>
      </div>

      <h2>Getting Started</h2>
      <p>To use this API:</p>
      <ol>
        <li>Find a video ID you want to scrape</li>
        <li>Get video information using the GET endpoint</li>
        <li>Access the video sources and other information from the response</li>
      </ol>

      <p>All downloaded videos are accessible at <code>/downloads/:videoId/:fileName</code></p>
    </body>
    </html>
  `);
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: err.message || "Something went wrong",
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Video Scraper API running on port ${PORT}`);
});

// Export for testing or modularity
module.exports = app;
