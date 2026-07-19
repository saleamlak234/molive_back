const { Resend } = require("resend");
const dotenv = require("dotenv");
require("dotenv").config(); // Adjust the path as necessary
const resend = new Resend(process.env.RESEND_API);
const sendEmail = async ({ sendTo, subject, html }) => {
  try {
    const { data, error } = await resend.emails.send({
      from: "dev <noreply@onboarding.dev>",
      to: sendTo,
      subject: subject,
      html: html,
    });
    if (error) {
      return console.error({ error });
    }
    console.log(data);
    return data;
  } catch (error) {
    console.log(error);
  }
};
// export default sendEmail
module.exports = sendEmail;
