import { type RawLottieAnimation } from "./rawTypes";

/**
 * Parses a lottie animation file from a URL and returns the json representation of the file.
 * @param urlToFile The URL to the Lottie animation file.
 * @returns The json representation of the lottie animation.
 */
export async function GetRawAnimationDataAsync(urlToFile: string): Promise<RawLottieAnimation> {
    const animationData = await (await fetch(urlToFile)).text();
    return JSON.parse(animationData) as RawLottieAnimation;
}
