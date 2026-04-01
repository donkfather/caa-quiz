import React, { useState, useEffect } from "react";
import { View } from "react-native";
import { BannerAd, BannerAdSize } from "react-native-google-mobile-ads";
import { BANNER_ID } from "../lib/ads";
import { loadSettings } from "../lib/settings";

export function AdBanner() {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    loadSettings().then((s) => setHidden(s.adsDisabled));
  }, []);

  if (hidden || process.env.DISABLE_ADS === "true") return null;

  return (
    <View style={{ alignItems: "center" }}>
      <BannerAd
        unitId={BANNER_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: true }}
        onAdFailedToLoad={() => setHidden(true)}
      />
    </View>
  );
}
