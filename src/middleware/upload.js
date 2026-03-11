"use strict";

const multer = require("multer");
const config = require("../config");

const storage = multer.memoryStorage(); // buffer in RAM → upload to Azure

const fileFilter = (req, file, cb) => {
  if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxSizeMb * 1024 * 1024,
  },
});

module.exports = upload;
