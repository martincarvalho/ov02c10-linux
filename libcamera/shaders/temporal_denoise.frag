/* SPDX-License-Identifier: LGPL-2.1-or-later */
/*
 * Copyright (C) 2026, Martin
 *
 * temporal_denoise.frag - Motion adaptive temporal denoise
 *
 * The software ISP has no denoise stage. That is fine in daylight and
 * ruinous under gain, where a sensor without a hardware ISP behind it hands
 * the application a picture whose noise is several percent of full scale.
 *
 * A spatial filter cannot fix this: it buys a noise reduction by spending
 * detail, and measured over a range of strengths it spends more than it
 * buys. A temporal filter has no such trade to make. A webcam scene is
 * nearly static, so averaging a pixel against its own past removes noise
 * without touching resolution at all - as long as the parts that are NOT
 * static are excluded, which is what the motion term below is for.
 */

//Pixel Shader
#ifdef GL_ES
precision highp float;
#endif

/** This frame, as it came out of the debayer pass. */
uniform sampler2D       tex_scene;
/** The frame this shader emitted last time. */
uniform sampler2D       tex_history;

varying vec2            textureOut;

/** One texel of the output, in texture coordinates. */
uniform vec2            tex_step;
/** Blend floor: the least of a static pixel that may come from this frame. */
uniform float           alphaMin;
/** Pooled difference below which the change is assumed to be noise. */
uniform float           motionLo;
/** Pooled difference above which the change is assumed to be motion. */
uniform float           motionHi;
/** Luma difference, in 8-bit units, that halves a chroma tap's weight. Zero disables. */
uniform float           chromaSigma;
/** Displacement field from the motion search, at half this resolution. */
uniform sampler2D       tex_motion;
/** Bias the stored displacement carries. See motion.frag. */
uniform float           motionBias;
/** Zero when the search did not run, which leaves the history where it is. */
uniform float           useMotion;
/**
 * Width of the neighbourhood the history is confined to, in deviations.
 *
 * Zero disables the clamp.
 */
uniform float           clampSigmas;
/** Least deviation the clamp will work with, so a flat patch stays open. */
uniform float           clampFloor;

/* Taps run -TAPS..TAPS in each axis; each one covers a 2x2 block. */
#define TAPS 2

void main(void)
{
	/*
	 * Where this pixel's own past is.
	 *
	 * A temporal filter averages a pixel against itself over time, which
	 * only works while the pixel stays put. The search has found, for each
	 * point, where its content sat in the previous output; shifting every
	 * history fetch by that lets the filter follow a moving subject
	 * instead of either smearing it or giving up on it.
	 *
	 * The field is stored at half this resolution and biased, since the
	 * target cannot hold negative numbers. Its vectors are in its own
	 * pixels, hence the doubling. And it is SUBTRACTED - see motion.frag.
	 */
	vec2 shift = vec2(0.0);

	if (useMotion > 0.5)
		shift = (texture2D(tex_motion, textureOut).rg * 255.0 - motionBias) *
			2.0 * tex_step;

	vec4 scene = texture2D(tex_scene, textureOut);
	vec4 history = texture2D(tex_history, textureOut - shift);
	float energy = 0.0;
	vec3 sceneSum = vec3(0.0);
	vec3 sceneSqSum = vec3(0.0);

	/*
	 * Chroma denoise rides along on the taps the motion detector already
	 * fetches, so it costs arithmetic but not bandwidth.
	 *
	 * Chroma is the one thing here that can be blurred cheaply: the eye
	 * resolves far less of it than of luma, which is why every video codec
	 * subsamples it. Luma is left untouched - each tap contributes only its
	 * own colour difference, and the centre pixel's luma is added back at
	 * the end, so the result carries exactly the luma it came in with.
	 *
	 * The weights are read off the history rather than off this frame.
	 * Under gain the incoming luma is too noisy to tell an edge from a
	 * speckle, while the history has already been through the temporal
	 * filter and is clean enough to guide with. It goes stale wherever
	 * something moves, but measurement says that costs less than the
	 * chroma noise it removes, even at ten pixels of motion per frame.
	 */
	float sceneLuma = (scene.r + scene.g + scene.b) / 3.0;
	float guideLuma = (history.r + history.g + history.b) / 3.0;
	vec3 chroma = scene.rgb - sceneLuma;
	float chromaWeight = 1.0;

	/*
	 * A single pixel cannot tell motion from noise. Under gain the
	 * frame-to-frame swing of one pixel is as large as the edge of a
	 * moving face, so any per-pixel threshold either ghosts or does
	 * nothing. Pooling the squared difference over a neighbourhood
	 * separates them, because noise averages down over the window and
	 * motion does not.
	 *
	 * Each fetch sits on a texel corner rather than a texel centre, so
	 * the linear filter returns the mean of a 2x2 block for the price of
	 * one sample. That is not merely cheaper: averaging before squaring
	 * drops the noise floor by four while leaving the motion signal
	 * untouched, so the detector separates them better than a plain box
	 * over the same 10x10 pixels would.
	 */
	for (int y = -TAPS; y <= TAPS; y++) {
		for (int x = -TAPS; x <= TAPS; x++) {
			vec2 uv = textureOut +
				  (vec2(float(x), float(y)) * 2.0 + 0.5) * tex_step;
			vec3 sceneTap = texture2D(tex_scene, uv).rgb;
			vec3 historyTap = texture2D(tex_history, uv - shift).rgb;
			vec3 d = sceneTap - historyTap;

			sceneSum += sceneTap;
			sceneSqSum += sceneTap * sceneTap;
			/*
			 * Equal channel weights, not luma ones: the debayer
			 * pass may emit BGR, and a metric that does not care
			 * about channel order cannot be wrong about it.
			 */
			float m = (d.r + d.g + d.b) / 3.0;

			energy += m * m;

			if (chromaSigma > 0.0) {
				float tapLuma = (sceneTap.r + sceneTap.g +
						 sceneTap.b) / 3.0;
				float tapGuide = (historyTap.r + historyTap.g +
						  historyTap.b) / 3.0;
				float dy = (tapGuide - guideLuma) * 255.0;
				float w = exp(-(dy * dy) /
					      (chromaSigma * chromaSigma));

				chroma += w * (sceneTap - tapLuma);
				chromaWeight += w;
			}
		}
	}

	/* Mean over the taps, carried to 8-bit units so the thresholds read in them. */
	energy *= 65025.0 / float((2 * TAPS + 1) * (2 * TAPS + 1));

	/*
	 * Ramp rather than a step. A hard threshold puts a visible seam
	 * around anything that moves, because neighbouring pixels land on
	 * opposite sides of it and get filtered by different amounts.
	 */
	float t = clamp((energy - motionLo) / (motionHi - motionLo), 0.0, 1.0);
	float alpha = alphaMin + (1.0 - alphaMin) * (t * t * (3.0 - 2.0 * t));

	/*
	 * Confine the history to what this frame's neighbourhood can account
	 * for.
	 *
	 * The blend above decides how much history to trust from how well it
	 * agrees with this frame at the SAME point, which is sound while the
	 * history is fetched from that point. Once the search is allowed to
	 * fetch it from somewhere else, that test can be passed by a wrong
	 * answer: over a flat wall every candidate scores alike, so noise
	 * picks the winner, and a search that reaches twenty pixels will
	 * sooner or later pick one sitting on an edge. The content it drags
	 * in agrees with itself, the blend sees no disagreement, and the edge
	 * is laid onto the wall as a streak that then feeds back through the
	 * history and stays.
	 *
	 * So bound the history by the spread of the neighbourhood instead. A
	 * temporal average of a flat patch lands on that patch's mean and
	 * passes untouched, which is the case the filter exists for and the
	 * one that must not be spoiled; content carried in from an edge lands
	 * far outside it and is cut back to the nearest thing this frame can
	 * support. The taps are 2x2 means, so their spread is half a pixel's
	 * and the floor is set to match.
	 */
	if (clampSigmas > 0.0) {
		const float count = float((2 * TAPS + 1) * (2 * TAPS + 1));
		vec3 mean = sceneSum / count;
		vec3 variance = max(sceneSqSum / count - mean * mean, 0.0);
		vec3 sigma = sqrt(variance) + clampFloor;

		history.rgb = clamp(history.rgb, mean - clampSigmas * sigma,
				    mean + clampSigmas * sigma);
	}

	vec3 denoised = chromaSigma > 0.0
			      ? vec3(sceneLuma) + chroma / chromaWeight
			      : scene.rgb;

	gl_FragColor = vec4(mix(history.rgb, denoised, alpha), scene.a);
}
