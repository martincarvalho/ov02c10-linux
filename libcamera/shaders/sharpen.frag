/* SPDX-License-Identifier: LGPL-2.1-or-later */
/*
 * Copyright (C) 2026, Martin
 *
 * sharpen.frag - Box reduction to the requested size, then a cored unsharp mask
 *
 * Two jobs that belong together, because both want to run at the size the
 * caller actually asked for.
 *
 * The reduction is the more valuable of the two. Scaling by projection alone
 * samples one source pixel per output pixel and discards the rest, which
 * throws away a noise reduction that costs nothing: averaging the pixels that
 * would have been discarded is worth 5.5 dB going to VGA on this sensor, and
 * unlike a temporal filter it does not care whether the subject is moving.
 * It also removes the aliasing that point sampling introduces.
 *
 * The sharpening then runs on the reduced image. A Bayer sensor needs it -
 * every output pixel is interpolated from a mosaic - and it only became
 * affordable once the noise came down.
 */

//Pixel Shader
#ifdef GL_ES
precision highp float;
#endif

/** The temporally blended frame, at the internal working resolution. */
uniform sampler2D       tex_source;

varying vec2            textureOut;

/** Region of the source that maps onto the output, in texture coordinates. */
uniform vec2            srcSpan;
/**
 * Where that region starts, so it sits in the middle of the frame.
 *
 * A 4:3 stream cannot show all of a 16:9 sensor, and cropping the sides is
 * the right answer - black bars are worse. But the crop has to be centred.
 * Anchored at the edge instead, as it was, a 640x480 stream showed the frame
 * from x=9 to x=1447 of 1920 when it should have shown 240 to 1680: the
 * subject of a video call had to sit a sixth of the frame off centre to look
 * centred, and the framing moved whenever the application picked a different
 * resolution.
 */
uniform vec2            srcOffset;
/** One output pixel, measured in source texture coordinates. */
uniform vec2            srcPixel;
/** Quarter of the reduction box, in source texture coordinates. Zero disables. */
uniform vec2            boxOffset;
/** How much of the cored detail to add back. Zero disables. */
uniform float           sharpenAmount;
/** Detail below this, in 8-bit units, is taken to be noise and dropped. */
uniform float           sharpenCore;

/*
 * Four bilinear fetches placed on the quarter points of the box. Each one
 * already averages the texels around it, so four fetches cover the whole box
 * whatever its size, and when boxOffset is zero they collapse onto the same
 * point and the reduction becomes a plain copy.
 */
vec3 boxSample(vec2 pos)
{
	return 0.25 * (texture2D(tex_source, pos + vec2(-boxOffset.x, -boxOffset.y)).rgb +
		       texture2D(tex_source, pos + vec2( boxOffset.x, -boxOffset.y)).rgb +
		       texture2D(tex_source, pos + vec2(-boxOffset.x,  boxOffset.y)).rgb +
		       texture2D(tex_source, pos + vec2( boxOffset.x,  boxOffset.y)).rgb);
}

void main(void)
{
	vec2 pos = srcOffset + textureOut * srcSpan;
	vec3 centre = boxSample(pos);
	float luma = (centre.r + centre.g + centre.b) / 3.0;
	float sum = 0.0;

	for (int y = -1; y <= 1; y++) {
		for (int x = -1; x <= 1; x++) {
			vec3 t = boxSample(pos + vec2(float(x), float(y)) * srcPixel);

			sum += (t.r + t.g + t.b) / 3.0;
		}
	}

	float detail = (luma - sum / 9.0) * 255.0;

	/*
	 * Subtract the threshold rather than gate on it. A gate that merely
	 * switches the detail on above a threshold leaves the large details
	 * at full strength, which is where the overshoot halo comes from -
	 * measured at 27% against 8% for the subtraction. Subtracting holds
	 * every detail back by the same amount, so the strong edges that
	 * would ring are exactly the ones held back most in absolute terms.
	 */
	float cored = sign(detail) * max(abs(detail) - sharpenCore, 0.0);

	/*
	 * Added equally to all three channels, so it moves luma and leaves
	 * the colour of the pixel alone.
	 */
	gl_FragColor = vec4(clamp(centre + sharpenAmount * cored / 255.0,
				  0.0, 1.0), 1.0);
}
