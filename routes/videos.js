const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const Video = require("../models/Video");
const VideoWatch = require("../models/VideoWatch");
const User = require("../models/User");
const Deposit = require("../models/Deposit");
const telegramService = require("../services/telegram");
const {
  payPendingCredits,
  reconcileMissedDailyReferralCommissionsForUpline,
  reconcileMissedDailyReferralCommissionsForUplineChain,
  isUserQualifiedForDailyReferral,
} = require("../services/commissionService");

const PACKAGE_DAILY_RETURN = {
  "8th Stock Package": 11040,
  "7th Stock Package": 5520,
  "6th Stock Package": 2750,
  "5th Stock Package": 1350,
  "4th Stock Package": 670,
  "3rd Stock Package": 330,
  "2nd Stock Package": 162,
  "1st Stock Package": 80,
};

const Commission = require("../models/Commission");

const router = express.Router();

// ========== HELPER FUNCTIONS ==========

const TIME_ZONE = "Africa/Nairobi";

const getTimeZoneOffsetMs = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const partMap = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  const localTimeUtc = Date.UTC(
    Number(partMap.year),
    Number(partMap.month) - 1,
    Number(partMap.day),
    Number(partMap.hour),
    Number(partMap.minute),
    Number(partMap.second),
  );

  const actualUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );

  return localTimeUtc - actualUtc;
};

// Get current date in the configured timezone (YYYY-MM-DD)
const getTodayServer = () => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
};

// Get today's date range in the configured timezone for DB queries
const getTodayRangeServer = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const offsetMs = getTimeZoneOffsetMs(now, TIME_ZONE);

  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs);
  const end = new Date(
    Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs,
  );
  return { start, end };
};

const deleteFileIfExists = async (absolutePath) => {
  try {
    await fs.promises.unlink(absolutePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Failed to delete file ${absolutePath}:`, err);
      throw err;
    }
  }
};

const deleteUploadUrlFile = async (url) => {
  if (!url) return;
  const cleanedUrl = url.replace(/^\//, "");
  const filePath = path.join(__dirname, "..", cleanedUrl);
  await deleteFileIfExists(filePath);
};

// Get latest completed main deposit (non-credit) for daily reward and referral calculations
const getFirstInitialDeposit = async (userId) => {
  return await Deposit.findOne({
    user: userId,
    status: "completed",
    package: { $ne: "Credit Payment" },
  }).sort({ createdAt: -1 });
};

// Check if user has pending deposit
const hasPendingDeposit = async (userId) => {
  const pendingDeposit = await Deposit.findOne({
    user: userId,
    status: "pending",
  });
  return !!pendingDeposit;
};

// Check duplicate payment prevention (already paid daily return today?)
const alreadyPaidDailyReturnToday = async (userId) => {
  const { start, end } = getTodayRangeServer();
  const commission = await Commission.findOne({
    user: userId,
    type: "dailyReturn",
    createdAt: { $gte: start, $lte: end },
  });
  return !!commission;
};

// Process and credit daily return for a user if they meet today's eligibility.
// Returns { claimed: boolean, amount?: number, message?: string }
const processDailyReturnForUserIfEligible = async (userId) => {
  try {
    const today = getTodayServer();
    const user = await User.findById(userId);
    if (!user) return { claimed: false, message: "User not found" };

    if (user.creditBlocked || user.pendingUplineCredit > 0) {
      return {
        claimed: false,
        message:
          "Cannot claim rewards while credit is pending or account is blocked.",
      };
    }

    const availableVideos = await Video.countDocuments({ isActive: true });
    if (availableVideos === 0) {
      return { claimed: false, message: "No active videos are available." };
    }

    const watchedCount = await VideoWatch.countDocuments({
      user: userId,
      watchDate: today,
      fullWatch: true,
    });

    if (watchedCount < availableVideos) {
      return {
        claimed: false,
        message: `Watch ${availableVideos - watchedCount} more video(s) fully to claim today's reward.`,
        videosWatchedToday: watchedCount,
        totalVideos: availableVideos,
      };
    }

    const firstDeposit = await getFirstInitialDeposit(userId);

    // Determine reward amount: package daily return or registration reward
    let ownDailyReturn = 0;
    let usingRegistrationReward = false;

    if (!firstDeposit) {
      const reg = user.registrationReward;
      const now = new Date();
      if (
        reg &&
        !user.hasMadeDeposit &&
        reg.startAt &&
        reg.expiresAt &&
        now >= reg.startAt &&
        now <= reg.expiresAt &&
        (reg.daysClaimed || 0) < (reg.daysTotal || 0)
      ) {
        ownDailyReturn = reg.amountPerDay || 32;
        usingRegistrationReward = true;
      } else {
        return {
          claimed: false,
          message:
            "A completed initial deposit is required to claim today's reward.",
        };
      }
    } else {
      ownDailyReturn = PACKAGE_DAILY_RETURN[firstDeposit.package] || 0;
      if (ownDailyReturn <= 0) {
        return {
          claimed: false,
          message: "Unable to calculate today's reward for your package.",
        };
      }
    }

    const alreadyPaid = await alreadyPaidDailyReturnToday(userId);
    if (alreadyPaid) {
      return {
        claimed: false,
        message: "Today's reward has already been claimed.",
      };
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $inc: { balance: ownDailyReturn } },
      { new: true },
    );

    await Commission.create({
      user: userId,
      fromUser: userId,
      amount: ownDailyReturn,
      level: 0,
      type: "dailyReturn",
      description: `Daily video reward for ${today}`,
    });

    // If registration reward was used, increment daysClaimed and clear when done
    if (usingRegistrationReward) {
      try {
        const reg = user.registrationReward || {};
        const newDays = (reg.daysClaimed || 0) + 1;
        const updates = { $set: {}, $unset: {} };
        updates.$set["registrationReward.daysClaimed"] = newDays;
        if (newDays >= (reg.daysTotal || 3)) {
          updates.$unset["registrationReward"] = "";
        }
        if (!Object.keys(updates.$unset).length) delete updates.$unset;
        await User.findByIdAndUpdate(userId, updates);
      } catch (e) {
        console.error("Error updating registration reward progress:", e);
      }
    }

    // Distribute to uplines (this function already prevents duplicate dailyReferral entries)
    await distributeVideoRewardCommissions(user, ownDailyReturn);

    return {
      claimed: true,
      amount: ownDailyReturn,
      balance: updatedUser.balance,
    };
  } catch (err) {
    console.error("Error processing daily return eligibility:", err);
    return { claimed: false, message: "Server error processing daily return" };
  }
};

// Distribute upline commissions for a user's video reward (5%/3%/1%)
const distributeVideoRewardCommissions = async (user, totalReward) => {
  try {
    if (!user) return;

    const UPLINE_RATES = [0.05, 0.03, 0.01];
    let currentUser = await User.findById(user.referredBy);
    let level = 1;

    const { start, end } = getTodayRangeServer();

    while (currentUser && level <= UPLINE_RATES.length) {
      const commissionAmount = Math.round(
        totalReward * UPLINE_RATES[level - 1],
      );

      // Prevent duplicate dailyReferral for same downline/upline on same day
      const existing = await Commission.findOne({
        user: currentUser._id,
        fromUser: user._id,
        type: "dailyReferral",
        createdAt: { $gte: start, $lte: end },
      });

      if (existing) {
        currentUser = await User.findById(currentUser.referredBy);
        level++;
        continue;
      }

      const uplineQualifiedCheck = await isUserQualifiedForDailyReferral(
        currentUser._id,
      );
      if (!uplineQualifiedCheck.qualified) {
        currentUser = await User.findById(currentUser.referredBy);
        level++;
        continue;
      }

      // Add commission to upline user's totalCommissions and balance
      await User.findByIdAndUpdate(currentUser._id, {
        $inc: { totalCommissions: commissionAmount, balance: commissionAmount },
      });

      await Commission.create({
        user: currentUser._id,
        fromUser: user._id,
        amount: commissionAmount,
        level,
        type: "dailyReferral",
        description: `Daily video referral commission from ${user.fullName}`,
      });

      currentUser = await User.findById(currentUser.referredBy);
      level++;
    }
  } catch (err) {
    console.error("Error distributing video reward commissions:", err);
  }
};

// Multer configuration for videos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "..", "uploads", "videos"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "video-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const THUMBNAIL_DIR = path.join(
  __dirname,
  "..",
  "uploads",
  "videos",
  "thumbnails",
);
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|avi|mov|wmv|flv|webm|mkv/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase(),
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

// Multer configuration for thumbnails
const thumbnailStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, THUMBNAIL_DIR);
  },
  filename: (req, file, cb) => {
    const videoId = req.params.videoId;
    cb(null, `thumbnail-${videoId}.jpg`);
  },
});

const uploadThumbnail = multer({
  storage: thumbnailStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit for thumbnails
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase(),
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Only image files are allowed for thumbnails"));
    }
  },
});

const generateThumbnail = (videoPath, filename) => {
  const thumbnailName = `${path.basename(filename, path.extname(filename))}.png`;
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ["10%"],
        filename: thumbnailName,
        folder: THUMBNAIL_DIR,
        size: "640x360",
      })
      .on("end", () => resolve(`/uploads/videos/thumbnails/${thumbnailName}`))
      .on("error", (err) => reject(err));
  });
};

const getVideoDuration = (videoPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        return reject(err);
      }
      const duration = metadata?.format?.duration;
      if (!duration || isNaN(duration)) {
        return reject(new Error("Unable to determine video duration"));
      }
      resolve(Math.ceil(duration));
    });
  });
};

// Admin middleware
const checkAdminPermission = (requiredRole) => {
  return (req, res, next) => {
    const userRole = req.user.role;
    if (requiredRole === "super_admin" && userRole !== "super_admin") {
      return res.status(403).json({ message: "Super admin access required" });
    }
    if (
      requiredRole === "admin" &&
      !["super_admin", "admin"].includes(userRole)
    ) {
      return res.status(403).json({ message: "Admin access required" });
    }
    next();
  };
};

// GET all videos (Admin only)
router.get("/", checkAdminPermission("admin"), async (req, res) => {
  try {
    const videos = await Video.find()
      .populate("uploadedBy", "fullName email")
      .sort({ createdAt: -1 });
    res.json({ videos });
  } catch (error) {
    console.error("Get videos error:", error);
    res.status(500).json({ message: "Server error fetching videos" });
  }
});

// POST upload video (Admin only)
router.post(
  "/",
  checkAdminPermission("admin"),
  upload.single("video"),
  async (req, res) => {
    try {
      const { title, rewardAmount } = req.body;

      if (!title?.trim()) {
        return res.status(400).json({
          message: "Title is required for video uploads.",
        });
      }

      if (!req.file) {
        return res.status(400).json({ message: "Video file is required" });
      }

      let durationSeconds;
      try {
        durationSeconds = await getVideoDuration(req.file.path);
      } catch (durationError) {
        console.error("Video duration extraction error:", durationError);
        return res.status(500).json({
          message:
            "Unable to determine video duration. Please upload a valid video file.",
        });
      }

      const video = new Video({
        title,
        videoUrl: `/uploads/videos/${req.file.filename}`,
        duration: durationSeconds,
        rewardAmount: Number(rewardAmount) || 0,
        uploadedBy: req.user._id,
      });

      await video.save();

      try {
        const thumbnailUrl = await generateThumbnail(
          req.file.path,
          req.file.filename,
        );
        video.thumbnailUrl = thumbnailUrl;
        await video.save();
      } catch (thumbnailError) {
        console.error("Thumbnail generation error:", thumbnailError);
      }

      res.status(201).json({ message: "Video uploaded successfully", video });
    } catch (error) {
      console.error("Upload video error:", error);
      res.status(500).json({ message: "Server error uploading video" });
    }
  },
);

// POST upload thumbnail for video
router.post(
  "/:videoId/thumbnail",
  uploadThumbnail.single("thumbnail"),
  async (req, res) => {
    try {
      const { videoId } = req.params;

      if (!mongoose.isValidObjectId(videoId)) {
        return res.status(400).json({ message: "Invalid video ID" });
      }

      const video = await Video.findById(videoId);
      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "Thumbnail file is required" });
      }

      video.thumbnailUrl = `/uploads/videos/thumbnails/${req.file.filename}`;
      await video.save();

      res.json({
        message: "Thumbnail uploaded successfully",
        thumbnailUrl: video.thumbnailUrl,
      });
    } catch (error) {
      console.error("Upload thumbnail error:", error);
      res.status(500).json({ message: "Server error uploading thumbnail" });
    }
  },
);

// PUT update video (Admin only)
router.put("/:videoId", checkAdminPermission("admin"), async (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, description, isActive, rewardAmount } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ message: "Video title is required." });
    }

    const updateData = {
      title,
      isActive,
    };

    if (typeof description !== "undefined") {
      updateData.description = description;
    }

    if (typeof rewardAmount !== "undefined") {
      updateData.rewardAmount = Number(rewardAmount) || 0;
    }

    const video = await Video.findByIdAndUpdate(videoId, updateData, {
      new: true,
    });

    if (!video) {
      return res.status(404).json({ message: "Video not found" });
    }

    res.json({ message: "Video updated successfully", video });
  } catch (error) {
    console.error("Update video error:", error);
    res.status(500).json({ message: "Server error updating video" });
  }
});

// DELETE video (Admin only)
router.delete("/:videoId", checkAdminPermission("admin"), async (req, res) => {
  try {
    const { videoId } = req.params;

    // Get video first without deleting
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video not found" });
    }

    // Delete video files from uploads folder first
    const videoFilePath = video.videoUrl
      ? path.join(__dirname, "..", video.videoUrl.replace(/^\//, ""))
      : null;
    const thumbnailFilePath = video.thumbnailUrl
      ? path.join(__dirname, "..", video.thumbnailUrl.replace(/^\//, ""))
      : null;

    if (videoFilePath) {
      await deleteFileIfExists(videoFilePath);
    }
    if (thumbnailFilePath) {
      await deleteFileIfExists(thumbnailFilePath);
    }

    // Then delete from database
    await Video.findByIdAndDelete(videoId);

    res.json({ message: "Video deleted successfully" });
  } catch (error) {
    console.error("Delete video error:", error);
    res.status(500).json({ message: "Server error deleting video" });
  }
});

// POST track video watch start
router.post("/:videoId/watch", async (req, res) => {
  try {
    const { videoId } = req.params;

    if (!mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video not found" });
    }

    const userId = req.user._id;
    const today = getTodayServer(); // Use server timezone

    const existingWatch = await VideoWatch.findOne({
      user: userId,
      video: videoId,
      watchDate: today,
    });

    if (existingWatch) {
      return res.json({
        message: "Already watched today",
        watch: existingWatch,
      });
    }

    const watch = new VideoWatch({
      user: userId,
      video: videoId,
      watchDate: today,
    });

    await watch.save();
    res.json({ message: "Watch started", watch });
  } catch (error) {
    console.error("Start watch error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ message: "Watch record already exists" });
    }
    res.status(500).json({ message: "Server error starting watch" });
  }
});

// PUT update video watch progress
router.put("/:videoId/watch/:watchId", async (req, res) => {
  try {
    const { videoId, watchId } = req.params;
    const { watchDuration, completed } = req.body;

    if (
      !mongoose.isValidObjectId(videoId) ||
      !mongoose.isValidObjectId(watchId)
    ) {
      return res.status(400).json({ message: "Invalid identifier" });
    }

    const userId = req.user._id;

    const watch = await VideoWatch.findOne({
      _id: watchId,
      user: userId,
      video: videoId,
    });

    if (!watch) {
      return res.status(404).json({ message: "Watch record not found" });
    }

    watch.watchDuration = watchDuration;
    watch.completed = completed;

    const video = await Video.findById(videoId);
    const user = await User.findById(userId);

    if (video && watchDuration >= video.duration && !watch.fullWatch) {
      watch.fullWatch = true;
      await Video.findByIdAndUpdate(videoId, {
        $inc: { totalViews: 1, dailyViews: 1 },
      });
    }
    await watch.save();

    let claimResult = null;
    if (watch.fullWatch) {
      try {
        claimResult = await processDailyReturnForUserIfEligible(user._id);

        if (claimResult.claimed) {
          const userRecord = await User.findById(user._id);
          if (
            userRecord &&
            !userRecord.creditBlocked &&
            userRecord.pendingUplineCredit <= 0
          ) {
            await reconcileMissedDailyReferralCommissionsForUpline(user._id);
            await reconcileMissedDailyReferralCommissionsForUplineChain(
              user._id,
            );
          }
        }
      } catch (err) {
        console.error("Auto-claim error after full watch:", err);
      }
    }

    const response = {
      message: "Watch updated",
      watch,
      info: watch.fullWatch
        ? "Full video watched (100%)"
        : `${Math.round((watchDuration / (video?.duration || 1)) * 100)}% watched`,
    };

    if (claimResult && claimResult.claimed) {
      response.claim = {
        message: "Today's reward automatically claimed.",
        amount: claimResult.amount,
        balance: claimResult.balance,
      };
    } else if (claimResult && claimResult.message) {
      response.claim = { message: claimResult.message };
    }

    res.json(response);
  } catch (error) {
    console.error("Update watch error:", error);
    res.status(500).json({ message: "Server error updating watch" });
  }
});

// GET user's video watch history
router.get("/history", async (req, res) => {
  try {
    const watches = await VideoWatch.find({ user: req.user._id })
      .populate("video", "title")
      .sort({ watchedAt: -1 });
    res.json({ watches });
  } catch (error) {
    console.error("Get watch history error:", error);
    res.status(500).json({ message: "Server error fetching watch history" });
  }
});

// GET today's video progress for user
router.get("/rewards/today", async (req, res) => {
  try {
    const userId = req.user._id;
    const today = getTodayServer(); // Use server timezone

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const watchedCount = await VideoWatch.countDocuments({
      user: userId,
      watchDate: today,
      fullWatch: true,
    });

    const availableVideos = await Video.countDocuments({ isActive: true });
    const qualifiesForDailyReturn =
      availableVideos > 0 && watchedCount >= availableVideos;

    const firstDeposit = await getFirstInitialDeposit(userId);
    const hasPendingCredit = user.pendingUplineCredit > 0 || user.creditBlocked;
    let todayRewards = 0;
    let ownDailyReturn = 0;
    let downlineDailyReturnCommission = 0;
    let warningMessage = "";

    if (hasPendingCredit) {
      warningMessage = "Please first pay your credit.";
    } else if (!firstDeposit) {
      warningMessage = "Please first make deposit.";
    }

    if (firstDeposit) {
      ownDailyReturn = PACKAGE_DAILY_RETURN[firstDeposit.package] || 0;
      const COMMISSION_RATES = [0.05, 0.03, 0.01];
      let currentLevelUserIds = [userId];

      for (let level = 1; level <= COMMISSION_RATES.length; level++) {
        const referrals = await User.find({
          referredBy: { $in: currentLevelUserIds },
        }).select("_id");

        if (referrals.length === 0) {
          break;
        }

        currentLevelUserIds = referrals.map((ref) => ref._id);
        const rate = COMMISSION_RATES[level - 1];

        for (const referral of referrals) {
          const referralDeposit = await getFirstInitialDeposit(referral._id);
          if (!referralDeposit) {
            continue;
          }

          const referralDailyReturn =
            PACKAGE_DAILY_RETURN[referralDeposit.package] || 0;
          const commissionAmount = Number(
            (referralDailyReturn * rate).toFixed(2),
          );
          downlineDailyReturnCommission += commissionAmount;
        }
      }

      todayRewards = Number(
        (ownDailyReturn + downlineDailyReturnCommission).toFixed(2),
      );
    }

    if (!warningMessage && !qualifiesForDailyReturn) {
      warningMessage = `Please first watch all videos. ${Math.max(
        0,
        availableVideos - watchedCount,
      )} remaining.`;
    }

    res.json({
      todayRewards,
      ownDailyReturn,
      downlineDailyReturnCommission,
      availableVideos,
      videosWatchedToday: watchedCount,
      qualifiesForDailyReturn,
      warningMessage: warningMessage || undefined,
      timezone: "server time",
    });
  } catch (error) {
    console.error("Get today's rewards error:", error);
    res.status(500).json({ message: "Server error fetching today's rewards" });
  }
});

// GET reward history for the authenticated user
router.get("/rewards/history", async (req, res) => {
  try {
    const userId = req.user._id;
    const rewards = await Commission.find({
      user: userId,
      type: { $in: ["dailyReturn", "dailyReferral"] },
    })
      .populate("fromUser", "fullName")
      .sort({ createdAt: -1 });

    res.json({ rewards });
  } catch (error) {
    console.error("Get reward history error:", error);
    res.status(500).json({ message: "Server error fetching reward history" });
  }
});

// GET today's earnings summary for display (does not credit balance immediately)
router.get("/today-earnings", async (req, res) => {
  try {
    const userId = req.user._id;
    const today = getTodayServer();

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const videosWatchedToday = await VideoWatch.countDocuments({
      user: userId,
      watchDate: today,
      fullWatch: true,
    });

    const totalAvailableVideos = await Video.countDocuments({ isActive: true });
    const pendingDeposit = await hasPendingDeposit(userId);
    const hasPendingCredit = user.pendingUplineCredit > 0;
    const isCreditBlocked = user.creditBlocked;
    const qualifiesForVideoEarnings =
      totalAvailableVideos > 0 && videosWatchedToday >= totalAvailableVideos;

    const warnings = [];
    if (hasPendingCredit) {
      warnings.push({
        type: "pending_credit",
        severity: "warning",
        message:
          "⚠️ You have pending credit. Please pay it first to unlock today's earnings.",
        action: "go_to_credit_payment",
        redirectUrl: "/credit-payment",
      });
    }
    if (!user.hasMadeDeposit && !pendingDeposit) {
      warnings.push({
        type: "no_deposit",
        severity: "info",
        message:
          "📌 Please make your first deposit to qualify for today's earnings.",
        action: "go_to_deposits",
        redirectUrl: "/deposits",
      });
    }

    const earnings = {
      totalToday: 0,
      ownDailyReturn: 0,
      downlineDailyReturnCommission: 0,
      videosWatchedToday,
      totalAvailableVideos,
      qualifiesForVideoEarnings,
      note: "Watch all active videos fully to qualify for today's earning display. Amount is shown only and will be credited at midnight.",
    };

    const firstDeposit = await getFirstInitialDeposit(userId);
    if (!firstDeposit) {
      if (!warnings.some((w) => w.type === "no_deposit")) {
        warnings.push({
          type: "no_deposit",
          severity: "info",
          message:
            "📌 Please make your first initial deposit to qualify for today's earnings.",
          action: "go_to_deposits",
          redirectUrl: "/deposits",
        });
      }
      return res.json({
        status: "success",
        message: "Today's earnings summary",
        timezone: "server time",
        warnings: warnings.length > 0 ? warnings : null,
        earnings,
      });
    }

    earnings.ownDailyReturn = PACKAGE_DAILY_RETURN[firstDeposit.package] || 0;

    const COMMISSION_RATES = [0.05, 0.03, 0.01];
    let currentLevelUserIds = [userId];
    let downlineDailyReturnCommission = 0;

    for (let level = 1; level <= COMMISSION_RATES.length; level++) {
      const referrals = await User.find({
        referredBy: { $in: currentLevelUserIds },
      }).select("_id");

      if (referrals.length === 0) {
        break;
      }

      currentLevelUserIds = referrals.map((ref) => ref._id);
      const rate = COMMISSION_RATES[level - 1];

      for (const referral of referrals) {
        const referralDeposit = await getFirstInitialDeposit(referral._id);
        if (!referralDeposit) {
          continue;
        }

        const referralDailyReturn =
          PACKAGE_DAILY_RETURN[referralDeposit.package] || 0;
        const commissionAmount = Number(
          (referralDailyReturn * rate).toFixed(2),
        );
        downlineDailyReturnCommission += commissionAmount;
      }
    }

    earnings.downlineDailyReturnCommission = Number(
      downlineDailyReturnCommission.toFixed(2),
    );

    const potentialVideoReward =
      PACKAGE_DAILY_RETURN[firstDeposit.package] || 0;
    earnings.potentialVideoReward = Number(potentialVideoReward.toFixed(2));

    earnings.totalToday = Number(
      (
        earnings.ownDailyReturn + earnings.downlineDailyReturnCommission
      ).toFixed(2),
    );

    earnings.displayTotal = Number(
      Math.max(
        earnings.ownDailyReturn,
        earnings.potentialVideoReward + earnings.downlineDailyReturnCommission,
      ).toFixed(2),
    );

    if (hasPendingCredit || isCreditBlocked) {
      earnings.note =
        "Unable to show credited earnings due to pending credit or account restrictions.";
      return res.json({
        status: "success",
        message: "Today's earnings summary",
        timezone: "server time",
        warnings: warnings.length > 0 ? warnings : null,
        earnings,
      });
    }

    if (!qualifiesForVideoEarnings) {
      earnings.note = `Watch ${Math.max(
        0,
        totalAvailableVideos - videosWatchedToday,
      )} more videos fully to unlock today's earnings display.`;
    } else {
      earnings.note =
        "Today's earnings are calculated from your first deposit daily return and downline daily-return commissions. They will be credited at midnight.";
    }

    res.json({
      status: "success",
      message: "Today's earnings summary",
      timezone: "server time",
      warnings: warnings.length > 0 ? warnings : null,
      earnings,
    });
  } catch (error) {
    console.error("Get today's earnings error:", error);
    res.status(500).json({ message: "Server error fetching today's earnings" });
  }
});

module.exports = router;
