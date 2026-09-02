/* SPDX-License-Identifier: LGPL-2.1-or-later */
/*
 * Copyright (C) 2026, Martin
 *
 * motion.frag - Per-pixel displacement between this frame and the last output
 *
 * A temporal filter can only average a pixel against its own past. When the
 * subject moves, the pixel's past is somewhere else in the previous frame, and
 * a filter that does not go and find it either smears or has to switch itself
 * off. Measured on this camera, the difference is large: matched to the right
 * place, moving content denoises almost as well as still content.
 *
 * The search is coarse to fine. Each level starts from the level above, so a
 * displacement of twenty pixels is found by three cheap searches rather than
 * one expensive one, and the coarse levels are also the quiet ones - halving
 * the image halves the noise, which is what makes the minimum findable at all.
 *
 * ON THE SIGN. This returns the displacement d for which
 *
 *     history(x - d) matches current(x)
 *
 * so the history must be resampled at x - d. Resampling at x + d applies the
 * motion backwards and doubles the misalignment, which comes out worse than
 * not compensating at all - a failure that looks exactly like the technique
 * not working.
 */

//Pixel Shader
#ifdef GL_ES
precision highp float;
#endif

/** Luma of this frame, at this pyramid level. */
uniform sampler2D       tex_current;
/** Luma of the previous output, at this pyramid level. */
uniform sampler2D       tex_history;
/** Displacement found one level up, in that level's pixels. */
uniform sampler2D       tex_prior;

varying vec2            textureOut;

/** One texel at this level, in texture coordinates. */
uniform vec2            tex_step;
/** Zero on the coarsest level, where there is nothing above to start from. */
uniform float           hasPrior;
/** How far to search around the starting point, in this level's pixels. */
uniform float           radius;
/**
 * Bias the displacement is stored with.
 *
 * Stored as the raw byte value mv + bias, not as a fraction of a range: GL
 * normalises an 8-bit channel by 255, so a range of 32 would put an integer
 * displacement of 1 at 0.53125, which is not a multiple of 1/255 and comes
 * back as 0.94. That error then doubles at every level on the way down.
 */
uniform float           mvBias;

/* Half-width of the block the candidates are compared over. */
#define WINDOW 2

void main(void)
{
	/* The level above has half this resolution, so its vectors are half as long. */
	vec2 prior = hasPrior > 0.5
			   ? (texture2D(tex_prior, textureOut).rg * 255.0 - mvBias) * 2.0
			   : vec2(0.0);

	vec2 best = prior;
	float bestCost = 1e9;

	for (float dy = -2.0; dy <= 2.0; dy += 1.0) {
		for (float dx = -2.0; dx <= 2.0; dx += 1.0) {
			if (abs(dy) > radius || abs(dx) > radius)
				continue;

			vec2 mv = prior + vec2(dx, dy);
			float cost = 0.0;

			for (int wy = -WINDOW; wy <= WINDOW; wy++) {
				for (int wx = -WINDOW; wx <= WINDOW; wx++) {
					vec2 o = vec2(float(wx), float(wy)) * tex_step;

					cost += abs(texture2D(tex_current, textureOut + o).r -
						    texture2D(tex_history,
							      textureOut + o - mv * tex_step).r);
				}
			}

			if (cost < bestCost) {
				bestCost = cost;
				best = mv;
			}
		}
	}

	/* Stored biased, because the target cannot hold negative numbers. */
	gl_FragColor = vec4((best + mvBias) / 255.0, 0.0, 1.0);
}
