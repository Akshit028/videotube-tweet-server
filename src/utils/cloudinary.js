import ImageKit from "imagekit";
import fs from "fs";

// Configure ImageKit
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

const uploadOnImageKit = async (localFilePath, uploadOptions) => {
  try {
    if (!localFilePath) return null;
    
    const fileContent = fs.readFileSync(localFilePath);

    const response = await imagekit.upload({
      file: fileContent, // required: can be a buffer, base64, or URL
      fileName: uploadOptions.fileName || "default_filename.jpg", // required: file name on ImageKit
      ...uploadOptions, // additional options like tags, folder, etc.
    });

    if (response) fs.unlinkSync(localFilePath); // Delete local file after upload
    return response;
  } catch (error) {
    fs.unlinkSync(localFilePath);
    console.log(error);
    return null;
  }
};

const deleteFromImageKit = async (fileId) => {
  try {
    if (!fileId) return null;

    const response = await imagekit.deleteFile(fileId);
    return response;
  } catch (error) {
    console.log(error);
    return null;
  }
};

export { uploadOnImageKit, deleteFromImageKit };
