const mongoose = require("mongoose");

const merchantAccountSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 80,
    },
    type: {
      type: String,
      enum: ["bank", "mobile_money"],
      required: true,
    },
    accountNumber: {
      type: String,
      trim: true,
      required: function () {
        return this.type === "bank";
      },
    },
    accountName: {
      type: String,
      trim: true,
    },
    bankName: {
      type: String,
      trim: true,
      required: function () {
        return this.type === "bank";
      },
    },
    phoneNumber: {
      type: String,
      trim: true,
      required: function () {
        return this.type === "mobile_money";
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    instructions: {
      type: String,
      default: "",
    },
    // qrCodeUrl: {
    //   type: String,
    //   default: null
    // }
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("MerchantAccount", merchantAccountSchema);
