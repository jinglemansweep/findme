/** One-shot high-accuracy fix for the manual update buttons (§4). */
export function getCurrentPosition(options?: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This browser does not support geolocation."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 5_000,
      ...options,
    });
  });
}

export function geolocationErrorMessage(err: unknown): string {
  if (err instanceof GeolocationPositionError) {
    switch (err.code) {
      case err.PERMISSION_DENIED:
        return "Location permission was denied. You can still place the pin by tapping the map.";
      case err.POSITION_UNAVAILABLE:
        return "Your location could not be determined right now. Try again, or tap the map.";
      case err.TIMEOUT:
        return "Finding your location took too long. Try again, or tap the map.";
    }
  }
  return err instanceof Error ? err.message : "Unknown location error.";
}
