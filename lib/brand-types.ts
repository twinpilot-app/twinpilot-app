export type Brand = {
  id: string;
  name: string;
  shortName: string;
  productName: string;
  tagline: string;
  legalName: string;
  holdingName: string;
  domain: string;
  supportEmail: string;
  urls: {
    website: string;
    landing: string;
    docs: string;
    github: string;
  };
  cli: {
    packageName: string;
    binName: string;
    configDir: string;
    repoUrl: string;
    repoName: string;
  };
  assets: {
    logoWordmark: string;
    logoMark: string;
    logoOnDark: string;
    logoWhite: string;
    logoBlack: string;
    favicon: string;
    ogImage: string;
    holdingLogoWhite: string;
  };
  copy: {
    maintenanceMessage: string;
    onboardWelcome: string;
    providersDisclaimerEn: string;
    providersDisclaimerPt: string;
  };
  theme: {
    tokensCss: string;
    typographyCss: string;
    defaultMode: "light" | "dark";
    primary: string;
    primaryHover: string;
    accent: string;
    accentHover: string;
    themeColor: string;
  };
};
