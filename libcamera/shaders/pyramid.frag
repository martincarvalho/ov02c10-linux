/* SPDX-License-Identifier: LGPL-2.1-or-later */
/*
 * Copyright (C) 2026, Martin
 *
 * pyramid.frag - Halve a luma image, for the motion search to work on
 *
 * The motion search runs on a pyramid rather than on the full frame for two
 * reasons. It lets a coarse level find large displacements cheaply and finer
 * levels only refine them, and - the reason that matters here - averaging
 * four pixels into one halves the noise, and a search under noise is a search
 * for the minimum of a surface that noise has flattened.
 */

//Pixel Shader
#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D       tex_source;
varying vec2            textureOut;

/** Set when the source is a colour image rather than an earlier pyramid level. */
uniform float           sourceIsColour;

void main(void)
{
	/*
	 * The destination is half the size, so a linear fetch at the centre of
	 * a destination texel lands exactly between four source texels and
	 * returns their average for the price of one sample.
	 */
	vec4 c = texture2D(tex_source, textureOut);
	float luma = sourceIsColour > 0.5 ? (c.r + c.g + c.b) / 3.0 : c.r;

	gl_FragColor = vec4(luma, luma, luma, 1.0);
}
