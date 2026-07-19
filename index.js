const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log("ffmpeg:", ffmpegPath, "ffprobe:", ffprobePath);
dotenv.config();
const connectDB = require("./config/db");
const Notification = require("./models/Notification");
// Ensure upload directories exist
const createUploadDirs = () => {
  const uploadDirs = [
    path.join(__dirname, "uploads"),
    path.join(__dirname, "uploads", "receipts"),
    path.join(__dirname, "uploads", "documents"),
    path.join(__dirname, "uploads", "avatars"),
    path.join(__dirname, "uploads", "videos"),
    path.join(__dirname, "uploads", "videos", "thumbnails"),
  ];

  uploadDirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  });
};

// Create upload directories on startup
createUploadDirs();

// Import routes
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposits");
const commissionRoutes = require("./routes/commissions");
const mlmRoutes = require("./routes/mlm");
const dashboardRoutes = require("./routes/dashboard");
const adminRoutes = require("./routes/admin");
const vipRoutes = require("./routes/vip");
const videoRoutes = require("./routes/videos");
const transactionRoutes = require("./routes/transactions");

// Import middleware
const authMiddleware = require("./middleware/auth");
const adminMiddleware = require("./middleware/admin");

// Import scheduled jobs
require("./jobs/vipBonuses");
// require("./jobs/dailyReturns");
require("./jobs/creditPenalties");
require("./jobs/dailyVideoReset");
// Video rewards are now processed on demand from the video page.
// require("./jobs/VideoRewards");

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
// Middleware
app.use(
  cors({
    origin: [
      "https://www.sahamtradingplc.com",
      "http://molivetradingplc.com",
      "http://molivetradingplc.com",
      "http://localhost:3000",
    ],
    optionsSuccessStatus: 200,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
); // Security middleware

// Add explicit CORS headers for all responses
const allowedOrigins = [
  "https://molivetradingplc.com",
  "http://molivetradingplc.com",
  "http://molivetradingplc.com",
  "http://localhost:3000",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization",
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create receipts subdirectory
const receiptsDir = path.join(__dirname, "uploads", "receipts");
if (!fs.existsSync(receiptsDir)) {
  fs.mkdirSync(receiptsDir, { recursive: true });
}
// Serve static files
app.use(
  "/uploads",
  express.static(uploadsDir, {
    setHeaders: (res, path) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization",
      );
      res.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
    },
  }),
);




// Routes
app.use("/auth", authRoutes);
app.use("/user", authMiddleware, userRoutes);
app.use("/deposits", authMiddleware, depositRoutes);
app.use("/commissions", authMiddleware, commissionRoutes);
app.use("/transactions", authMiddleware, transactionRoutes);
app.use("/mlm", authMiddleware, mlmRoutes);
app.use("/dashboard", authMiddleware, dashboardRoutes);
app.use("/vip", authMiddleware, vipRoutes);
app.use("/admin", authMiddleware, adminRoutes);

const buildUrl = (req, url) => {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${req.protocol}://${req.get("host")}${url}`;
};

// Public video routes (no auth required)
app.get("/videos/active", async (req, res) => {
  try {
    const Video = require("./models/Video");
    const videos = await Video.find({ isActive: true })
      .select(
        "title description videoUrl thumbnailUrl duration rewardAmount totalViews",
      )
      .sort({ createdAt: -1 })
      .lean();

    const mappedVideos = videos.map((video) => ({
      ...video,
      videoUrl: buildUrl(req, video.videoUrl),
      thumbnailUrl: buildUrl(req, video.thumbnailUrl),
    }));

    res.json({ videos: mappedVideos });
  } catch (error) {
    console.error("Get active videos error:", error);
    res.status(500).json({ message: "Server error fetching videos" });
  }
});

app.use("/videos", authMiddleware, videoRoutes);

app.get("/notifications/active", async (req, res) => {
  try {
    const notifications = await Notification.find({ isActive: true })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ notifications });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({ message: "Server error fetching notifications" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;
connectDB.then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});

module.exports = app;
