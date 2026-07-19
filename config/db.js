const mongoose = require("mongoose");
require("dotenv").config();
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // These listeners handle issues after the initial connection
    mongoose.connection.on("error", (err) => {
      console.error(
        "❌ MongoDB connection error after initial connection:",
        err,
      );
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected. Attempting to reconnect...");
      // Mongoose will try to reconnect automatically
    });
  } catch (err) {
    console.error("❌ Initial MongoDB connection error:", err);
    // Instead of letting the app crash, you might want to retry or exit gracefully
    process.exit(1);
  }
};

module.exports = connectDB();
