const mongoose = require("mongoose");
const User = require("../models/User");
const MerchantAccount = require("../models/MerchantAccount");
const dotenv = require("dotenv");
dotenv.config();
const connectDB = require("../config/db");

// const MONGODB_URI="mongodb://localhost:27017/fam@1234"
async function seedDatabase() {
  try {
    // Connect to MongoDB
    // await mongoose.connect(process.env.MONGODB_URI);
    await connectDB;
    console.log("Connected to MongoDB");
    // Create or find super admin
    let superAdmin = await User.findOne({ email: "devsource79@gmail.com" });
    if (!superAdmin) {
      superAdmin = new User({
        fullName: " Molive",
        email: "devsource79@gmail.com",
        phoneNumber: "+251998107401",
        password: "molive1234",
        role: "super_admin",
        referralCode: "SUPER001",
        isActive: true,
      });
      await superAdmin.save();
      console.log("Super Admin created:", superAdmin.email);
    } else {
      console.log("Super Admin already exists:", superAdmin.email);
    }

    let admin = await User.findOne({ email: "server01@gmail.com" });
    if (!admin) {
      admin = new User({
        fullName: "Main Admin",
        email: "server01@gmail.com",
        phoneNumber: "+251910000000",
        password: "admin123",
        role: "admin",
        referralCode: "ADMIN001",
        isActive: true,
      });
      await admin.save();
      console.log("Main Admin created:", admin.email);
    } else {
      console.log("Main Admin already exists:", admin.email);
    }

    let transactionAdmin = await User.findOne({
      email: "server02@gmail.com",
    });
    if (!transactionAdmin) {
      transactionAdmin = new User({
        fullName: "source dev",
        email: "server02@gmail.com",
        phoneNumber: "+251900000000",
        password: "transadmin123",
        role: "transaction_admin",
        referralCode: "TRANS001",
        isActive: true,
      });
      await transactionAdmin.save();
      console.log("Transaction Admin created:", transactionAdmin.email);
    } else {
      console.log("Transaction Admin already exists:", transactionAdmin.email);
    }

    // Create sample users

    // Create merchant accounts
    const merchantAccounts = [
      {
        name: "cbe Bank Account",
        type: "bank",
        accountNumber: "never",
        accountName: "none",
        bankName: "cbe Bank",
        instructions:
          "Transfer to this account and provide transaction reference",
        isActive: true,
      },
      {
        name: "TeleBirr Account",
        type: "mobile_money",
        accountName: "samson",
        phoneNumber: "09000000",
        instructions:
          "Send money to this TeleBirr number and provide transaction ID",
        isActive: true,
      },

      {
        name: "TeleBirr Account",
        type: "mobile_money",
        accountName: " meron",
        phoneNumber: "090000000",
        instructions: "Send money to this M-Birr number and provide reference",
        isActive: true,
      },
    ];

    for (const accountData of merchantAccounts) {
      const normalizedData = {
        name: accountData.name,
        type: accountData.type,
        accountName: accountData.accountName,
        instructions: accountData.instructions,
        isActive: accountData.isActive,
        accountNumber:
          accountData.type === "bank"
            ? String(accountData.accountNumber).trim()
            : undefined,
        bankName:
          accountData.type === "bank" ? accountData.bankName : undefined,
        phoneNumber:
          accountData.type === "mobile_money"
            ? String(accountData.phoneNumber).trim()
            : undefined,
      };

      const existingAccount = await MerchantAccount.findOne({
        user: admin._id,
        name: normalizedData.name,
        type: normalizedData.type,
        phoneNumber: normalizedData.phoneNumber,
      });

      if (!existingAccount) {
        const account = new MerchantAccount({
          ...normalizedData,
          user: admin._id,
        });
        await account.save();
        console.log("Merchant account created:", account.name);
      } else {
        console.log("Merchant account already exists:", existingAccount.name);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error("Seed error:", error);
    process.exit(1);
  }
}

seedDatabase();
