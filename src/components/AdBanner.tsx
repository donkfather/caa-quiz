import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { BannerAd, BannerAdSize } from "react-native-google-mobile-ads";
import { BANNER_ID } from "../lib/ads";
import { loadSettings } from "../lib/settings";

export function AdBanner() {
  const [failed, setFailed] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    loadSettings().then((s) => setAllowed(!s.adsDisabled));
  }, []);

  if (allowed !== true || failed) return null;

  return (
    <View style={{ alignItems: "center" }}>
      <BannerAd
        unitId={BANNER_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: true }}
        onAdFailedToLoad={() => setFailed(true)}
      />
    </View>
  );
}
