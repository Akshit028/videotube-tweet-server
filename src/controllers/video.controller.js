import mongoose, { isValidObjectId } from "mongoose";
import { Video } from "../models/video.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { video_upOptions, thumbnail_upOptions } from "../constants.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Like } from "../models/like.model.js";
import { Comment } from "../models/comment.model.js";
import {
  uploadOnImageKit,
  deleteFromImageKit,
} from "../utils/cloudinary.js"; // Updated import to imageKit.js

const getAllVideos = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, query, sortBy, sortType, userId } = req.query;

  const pipeline = [];
  if (query) {
    pipeline.push({
      $search: {
        index: "search-videos",
        text: {
          query: query,
          path: ["title", "description"],
        },
      },
    });
  }
  if (userId) {
    if (!isValidObjectId(userId)) {
      throw new ApiError(400, "Invalid userId");
    }

    pipeline.push({
      $match: {
        owner: new mongoose.Types.ObjectId(userId),
      },
    });
  }

  pipeline.push({ $match: { isPublished: true } });

  if (sortBy && sortType) {
    pipeline.push({
      $sort: {
        [sortBy]: sortType === "asc" ? 1 : -1,
      },
    });
  } else {
    pipeline.push({ $sort: { createdAt: -1 } });
  }

  pipeline.push(
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [
          {
            $project: {
              username: 1,
              "avatar.url": 1,
            },
          },
        ],
      },
    },
    {
      $unwind: "$ownerDetails",
    }
  );

  const videoAggregate = Video.aggregate(pipeline);

  const options = {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
  };

  const videos = await Video.aggregatePaginate(videoAggregate, options);

  return res
    .status(200)
    .json(new ApiResponse(200, videos, "Videos fetched successfully"));
});

const publishAVideo = asyncHandler(async (req, res) => {
  const { title, description, isPublished } = req.body;

  if (
    [title, description, isPublished].some(
      (field) => field === undefined || field?.trim() === ""
    )
  ) {
    throw new ApiError(400, "All fields are required");
  }

  const videoLocalPath = req.files?.video[0]?.path;
  if (!videoLocalPath) throw new ApiError(401, "Video is required to publish");

  const thumbnailLocalPath = req.files?.thumbnail[0]?.path;
  if (!thumbnailLocalPath)
    throw new ApiError(401, "Thumbnail is required to publish");

  const [videoFile, thumbnailFile] = await Promise.all([
    uploadOnImageKit(videoLocalPath, video_upOptions),
    uploadOnImageKit(thumbnailLocalPath, thumbnail_upOptions),
  ]);

  if (!videoFile || !thumbnailFile) {
    let errorMessage = "";
    if (!videoFile) errorMessage += "Failed to upload video. ";
    if (!thumbnailFile) errorMessage += "Failed to upload thumbnail.";
    throw new ApiError(500, errorMessage);
  }

  const video = await Video.create({
    video: {
      fileId: videoFile.fileId, // Ensure ImageKit returns fileId
      url: videoFile.url, // Ensure ImageKit returns url
    },
    thumbnail: {
      fileId: thumbnailFile.fileId, // Ensure ImageKit returns fileId
      url: thumbnailFile.url, // Ensure ImageKit returns url
    },
    duration: videoFile.duration,
    title,
    description,
    isPublished,
    owner: req.user._id,
  });

  if (!video) throw new ApiError(500, "Failed to publish video");

  return res
    .status(201)
    .json(new ApiResponse(201, video, "Video published successfully"));
});

const getVideoByIdForGuest = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  if (!videoId?.trim()) throw new ApiError(400, "Video Id is missing");

  if (!isValidObjectId(videoId)) throw new ApiError(400, "Invalid VideoID");

  const video = await Video.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(videoId),
        isPublished: true,
      },
    },
    {
      $lookup: {
        from: "likes",
        localField: "_id",
        foreignField: "video",
        as: "likes",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "owner",
        pipeline: [
          {
            $lookup: {
              from: "subscriptions",
              localField: "_id",
              foreignField: "channel",
              as: "subscribers",
            },
          },
          {
            $addFields: {
              subscribersCount: {
                $size: "$subscribers",
              },
              isSubscribed: false,
            },
          },
          {
            $project: {
              username: 1,
              "avatar.url": 1,
              subscribersCount: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        likesCount: {
          $size: "$likes",
        },
        owner: {
          $first: "$owner",
        },
        isLiked: false,
      },
    },
    {
      $project: {
        "video.url": 1,
        title: 1,
        description: 1,
        views: 1,
        createdAt: 1,
        duration: 1,
        comments: 1,
        owner: 1,
        likesCount: 1,
        isLiked: 1,
        isSubscribed: 1,
      },
    },
  ]);

  if (!video) throw new ApiError(404, "Video not found");

  return res.status(200).json(new ApiResponse(200, video[0], "Video found"));
});

const getVideoById = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const isGuest = req.query.guest === "true";

  if (!videoId?.trim()) throw new ApiError(400, "Video Id is missing");
  if (!isValidObjectId(videoId)) throw new ApiError(400, "Invalid VideoID");

  const video = await Video.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(videoId),
      },
    },
    {
      $lookup: {
        from: "likes",
        localField: "_id",
        foreignField: "video",
        as: "likes",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "owner",
        pipeline: [
          {
            $lookup: {
              from: "subscriptions",
              localField: "_id",
              foreignField: "channel",
              as: "subscribers",
            },
          },
          {
            $addFields: {
              subscribersCount: {
                $size: "$subscribers",
              },
              isSubscribed: {
                $cond: {
                  if: isGuest,
                  then: false,
                  else: {
                    $cond: {
                      if: {
                        $in: [req.user?._id, "$subscribers.subscriber"],
                      },
                      then: true,
                      else: false,
                    },
                  },
                },
              },
            },
          },
          {
            $project: {
              username: 1,
              fullName: 1,
              "avatar.url": 1,
              subscribersCount: 1,
              isSubscribed: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        likesCount: {
          $size: "$likes",
        },
        owner: {
          $first: "$owner",
        },
        isLiked: {
          $cond: {
            if: isGuest,
            then: false,
            else: {
              $cond: {
                if: { $in: [req.user?._id, "$likes.likedBy"] },
                then: true,
                else: false,
              },
            },
          },
        },
      },
    },
    {
      $project: {
        "video.url": 1,
        title: 1,
        description: 1,
        views: 1,
        createdAt: 1,
        duration: 1,
        comments: 1,
        owner: 1,
        likesCount: 1,
        isLiked: 1,
        isSubscribed: 1,
        subscribersCount: 1,
      },
    },
  ]);

  if (!video.length) throw new ApiError(404, "Video not found");

  return res.status(200).json(new ApiResponse(200, video[0], "Video found"));
});

const updateVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid videoId");
  }

  const { title, description } = req.body;
  const thumbnailLocalPath = req.file?.path;

  const currentVideo = await Video.findById(videoId);

  if (!currentVideo) throw new ApiError(401, "Video cannot be found");
  if (
    [title, description].some(
      (field) => field === undefined || field?.trim() === ""
    )
  ) {
    throw new ApiError(400, "All fields are required");
  }

  if (currentVideo?.owner.toString() !== req.user?._id.toString()) {
    throw new ApiError(
      400,
      "You can't edit this video as you are not the owner"
    );
  }

  let update = {
    $set: {
      title,
      description,
    },
  };

  if (thumbnailLocalPath) {
    const thumbnailFile = await uploadOnImageKit(
      thumbnailLocalPath,
      thumbnail_upOptions
    );

    if (!thumbnailFile) throw new ApiError(501, "Thumbnail uploading failed");

    await deleteFromImageKit(currentVideo?.thumbnail.fileId);

    update.$set.thumbnail = {
      fileId: thumbnailFile.fileId,
      url: thumbnailFile.url,
    };
  }

  const video = await Video.findByIdAndUpdate(videoId, update, {
    new: true,
  });

  if (!video) throw new ApiError(501, "Updating Video failed");

  return res
    .status(200)
    .json(new ApiResponse(200, video, "Video updated successfully"));
});

const deleteVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const currentVideo = await Video.findById(videoId);

  if (!currentVideo) throw new ApiError(404, "Video not found");

  const deleteVideo = await Video.findByIdAndDelete(videoId);

  if (!deleteVideo) throw new ApiError(500, "Video deletion failed");

  await Promise.all([
    Like.deleteMany({ video: videoId }),
    Comment.deleteMany({ video: videoId }),
    deleteFromImageKit(currentVideo?.video.fileId),
    deleteFromImageKit(currentVideo?.thumbnail.fileId),
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Video deleted Successfully"));
});

const togglePublishStatus = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const video = await Video.findById(videoId);

  if (!video) throw new ApiError(404, "Video not found");

  video.isPublished = !video.isPublished;

  await video.save({ validateBeforeSave: false });

  return res
    .status(200)
    .json(new ApiResponse(200, video, "Video publish status updated"));
});

const getNextVideos = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!isValidObjectId(videoId)) throw new ApiError(400, "Invalid videoId");

  const video = await Video.findById(videoId);

  if (!video) throw new ApiError(404, "Video not found");

  const nextVideos = await Video.aggregate([
    {
      $match: {
        _id: {
          $ne: new mongoose.Types.ObjectId(videoId),
        },
        isPublished: true,
      },
    },
    {
      $sample: {
        size: 10,
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [
          {
            $project: {
              username: 1,
              "avatar.url": 1,
            },
          },
        ],
      },
    },
    {
      $unwind: "$ownerDetails",
    },
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, nextVideos, "Next videos fetched successfully"));
});

const updateVideoViews = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const userId = req.user?._id;

  if (!isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid videoId");
  }

  const video = await Video.findById(videoId);
  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const watchHistoryEntry = user.watchHistory.find(
    (entry) => entry.video.toString() === videoId
  );

  if (!watchHistoryEntry) {
    await Video.findByIdAndUpdate(videoId, { $inc: { views: 1 } });

    user.watchHistory.push({
      video: videoId,
      watchedAt: new Date(),
    });

    await user.save();
  } else {
    watchHistoryEntry.watchedAt = new Date();
    await user.save();
  }

  return res
    .status(200)
    .json(
      new ApiResponse(200, { video, user }, "Video views updated successfully")
    );
});

export {
  getAllVideos,
  publishAVideo,
  getVideoById,
  updateVideo,
  deleteVideo,
  togglePublishStatus,
  getNextVideos,
  updateVideoViews,
  getVideoByIdForGuest,
};
