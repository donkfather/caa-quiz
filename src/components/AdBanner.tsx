import React, { useState, useEffect } from "react";
import { View } from "react-native";
import { BannerAd, BannerAdSize } from "react-native-google-mobile-ads";
import { BANNER_ID, waitForAds } from "../lib/ads";

export function AdBanner() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    waitForAds().then((initialized) => setReady(initialized));
  }, []);

  if (!ready) return null;

  return (
    <View style={{ alignItems: "center" }}>
      <BannerAd
        unitId={BANNER_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: true }}
      />
    </View>
  );
}
