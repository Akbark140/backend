// controllers/contact.controller.js
const  contactService = require("./contact.service.js");

  /**
   * HTTP Handler to process arriving inquiries safely.
   */
async function submitContact(req, res, next){
    try {
        const { name, email, topic, budget, message } = req.body;

        // Delegate pure execution logic down the abstraction layer
        const newSubmission = await contactService.processSubmission({
            name,
            email,
            topic,
            budget,
            message
        });

        return res.status(201).json({
            success: true,
            message: "Your inquiry has been logged successfully.",
            data: newSubmission
        });
    } catch (error) {
        // Pass execution safely to the global express error handler pipeline
        next(error);
    }
}

module.exports = {
    submitContact,
};