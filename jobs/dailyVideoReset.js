const cron = require("node-cron");
const Video = require("../models/Video");
const VideoWatch = require("../models/VideoWatch");

const TIME_ZONE = "Africa/Nairobi";

const resetDailyVideoStats = async () => {
  try {
    // Reset daily views for all videos
    await Video.updateMany({}, { dailyViews: 0, lastResetDate: new Date() });

    console.log("Daily video stats reset completed");
  } catch (error) {
    console.error("Daily video reset error:", error);
  }
};

// Schedule to run daily at midnight in the configured timezone
cron.schedule(
  "0 0 * * *",
  async () => {
    console.log("Running daily video stats reset...");
    await resetDailyVideoStats();
  },
  {
    scheduled: true,
    timezone: TIME_ZONE,
  },
);

console.log(
  "dailyVideoReset job loaded and scheduled to run daily at midnight",
);

module.exports = { resetDailyVideoStats };
