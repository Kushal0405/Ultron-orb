// Real weather for the HUD's weather panel: your browser's geolocation, sent
// to two free, keyless, CORS-friendly APIs — open-meteo.com for the reading,
// bigdatacloud.net for a human place name from the coordinates. Nothing is
// sent anywhere else, and if either call or geolocation fails/is denied, the
// panel simply doesn't render rather than showing a placeholder as if real.

const WEATHER_LABEL: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Rain showers",
  82: "Violent showers",
  95: "Thunderstorm",
};

export interface WeatherReading {
  tempC: number;
  condition: string;
  place: string;
}

function getPosition(timeoutMs: number): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    // Belt-and-braces timeout: some browsers/environments never invoke
    // either getCurrentPosition callback at all, so the `timeout` option
    // below can't be trusted alone to bound how long this takes.
    let settled = false;
    const finish = (value: GeolocationPosition | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const guard = setTimeout(() => finish(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(guard);
        finish(pos);
      },
      () => {
        clearTimeout(guard);
        finish(null);
      },
      { timeout: timeoutMs, maximumAge: 10 * 60 * 1000 },
    );
  });
}

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
    );
    if (!res.ok) throw new Error("geocode failed");
    const data = await res.json();
    return data.city || data.locality || data.principalSubdivision || `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
  } catch {
    return `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
  }
}

export async function fetchWeather(): Promise<WeatherReading | null> {
  const position = await getPosition(6000);
  if (!position) return null;

  const { latitude, longitude } = position.coords;
  try {
    const [weatherRes, place] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`),
      reverseGeocode(latitude, longitude),
    ]);
    if (!weatherRes.ok) return null;
    const data = await weatherRes.json();
    const tempC = data?.current?.temperature_2m;
    const code = data?.current?.weather_code;
    if (typeof tempC !== "number") return null;
    return { tempC, condition: WEATHER_LABEL[code] ?? "—", place };
  } catch {
    return null;
  }
}
