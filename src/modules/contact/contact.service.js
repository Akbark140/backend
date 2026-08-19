// services/contact.service.js
const contactRepository = require("./contact.repository");

class ContactService {
  /**
   * Processes contact submission requests with validation checks.
   */
  async processSubmission(contactData) {
    const { name, email, topic, message } = contactData;

    // Core server-side business logic sanity guards
    if (!name?.trim() || !email?.trim() || !topic || !message?.trim()) {
      throw new Error("Missing required fields for contact submission.");
    }

    if (message.trim().length < 20) {
      throw new Error("Message length must be at least 20 characters long.");
    }

    // Persist to relational storage unit
    const submission = await contactRepository.create(contactData);

    // Contextual expansion block: 
    // You can safely invoke transactional background routines here, such as:
    // await emailService.sendContactAcknowledgment(email, name);

    return submission;
  }
}

module.exports = new ContactService();